import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '../../../../shared/domain/errors/index.ts';
import type { Db, Tx } from '../../../../shared/infrastructure/db/client.ts';
import { Operation, type NewOperation } from '../../domain/entities/Operation.ts';
import type {
  OperationRepository,
  SettleOutcome,
  PaymentWebhookEvent,
} from '../../domain/repositories/OperationRepository.ts';
import {
  OperationStatus,
  SETTLEABLE_STATUSES,
} from '../../domain/value-objects/OperationStatus.ts';
import {
  classifyWebhookResult,
  WebhookEventResult,
} from '../../domain/value-objects/WebhookEventResult.ts';
import { ChargeOutcome, DEFAULT_DECLINE_REASON } from '../../domain/gateways/PaymentProvider.ts';
import { ledgerEntries, operations, wallets, webhookEvents } from './schema.ts';

type OperationRow = typeof operations.$inferSelect;

const restore = (row: OperationRow, newBalanceCents: number | null = null): Operation => {
  const { reconcileLockedUntil: _lease, ...data } = row;
  return Operation.restore({ ...data, newBalanceCents });
};

export class DrizzleOperationRepository implements OperationRepository {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async claim(input: NewOperation): Promise<{ created: boolean; operation: Operation }> {
    const operation = Operation.create(input);
    return this.db.transaction(async (tx) => {
      await tx.insert(wallets).values({ userId: operation.userId }).onConflictDoNothing();
      const [inserted] = await tx
        .insert(operations)
        .values({
          ...input,
          status: operation.status,
        })
        .onConflictDoNothing({ target: operations.idempotencyKey })
        .returning();
      if (inserted) return { created: true, operation: restore(inserted) };

      const [existing] = await tx
        .select({ row: operations, balance: ledgerEntries.balanceAfterCents })
        .from(operations)
        .leftJoin(ledgerEntries, eq(ledgerEntries.operationId, operations.id))
        .where(eq(operations.idempotencyKey, input.idempotencyKey));
      if (!existing) throw new NotFoundError('Cash-in operation not found');
      return { created: false, operation: restore(existing.row, existing.balance) };
    });
  }

  async findById(id: string, tx?: Tx): Promise<Operation | null> {
    const [found] = await (tx ?? this.db)
      .select({ row: operations, balance: ledgerEntries.balanceAfterCents })
      .from(operations)
      .leftJoin(ledgerEntries, eq(ledgerEntries.operationId, operations.id))
      .where(eq(operations.id, id));
    return found ? restore(found.row, found.balance) : null;
  }

  async markUnknown(id: string): Promise<void> {
    await this.db
      .update(operations)
      .set({ status: OperationStatus.UNKNOWN, updatedAt: sql`now()` })
      .where(and(eq(operations.id, id), eq(operations.status, OperationStatus.PROCESSING)));
  }

  async settle(
    id: string,
    outcome: SettleOutcome,
    tx?: Tx,
  ): Promise<{ applied: boolean; operation: Operation }> {
    if (!tx) return this.db.transaction((client) => this.settle(id, outcome, client));

    const [changed] = await tx
      .update(operations)
      .set({
        status: outcome.status,
        providerChargeId:
          outcome.status === OperationStatus.COMPLETED ? outcome.providerChargeId : null,
        failureReason: outcome.status === OperationStatus.FAILED ? outcome.reason : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(operations.id, id), inArray(operations.status, SETTLEABLE_STATUSES)))
      .returning();

    if (!changed) {
      const existing = await this.findById(id, tx);
      if (!existing) throw new NotFoundError('Cash-in operation not found');
      return { applied: false, operation: existing };
    }

    if (outcome.status === OperationStatus.FAILED)
      return { applied: true, operation: restore(changed) };

    const [wallet] = await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${changed.amountCents}`,
        updatedAt: sql`now()`,
      })
      .where(eq(wallets.userId, changed.userId))
      .returning({ balance: wallets.balanceCents });
    if (!wallet) throw new NotFoundError('Wallet not found');

    await tx
      .insert(ledgerEntries)
      .values({
        operationId: id,
        userId: changed.userId,
        amountCents: changed.amountCents,
        balanceAfterCents: wallet.balance,
      });
    return { applied: true, operation: restore(changed, wallet.balance) };
  }

  async leasePendingBatch(
    olderThanMs: number,
    leaseMs: number,
    limit: number,
  ): Promise<Operation[]> {
    // This transaction only reserves rows. It commits before any caller can perform external I/O.
    return this.db.transaction(async (tx) => {
      const candidates = tx
        .select({ id: operations.id })
        .from(operations)
        .where(
          and(
            or(
              eq(operations.status, OperationStatus.UNKNOWN),
              and(
                eq(operations.status, OperationStatus.PROCESSING),
                lt(operations.updatedAt, sql`now() - ${olderThanMs} * interval '1 millisecond'`),
              ),
            ),
            or(
              isNull(operations.reconcileLockedUntil),
              lt(operations.reconcileLockedUntil, sql`now()`),
            ),
          ),
        )
        .orderBy(operations.updatedAt)
        .limit(limit)
        .for('update', { skipLocked: true });

      const reserved = await tx
        .update(operations)
        .set({
          reconcileLockedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
        })
        .where(inArray(operations.id, candidates))
        .returning();
      return reserved.map((row) => restore(row));
    });
  }

  async applyWebhookEvent(
    event: PaymentWebhookEvent,
  ): ReturnType<OperationRepository['applyWebhookEvent']> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(webhookEvents)
        .values({
          eventId: event.eventId,
          operationId: event.operationId,
          status: event.status,
          result: WebhookEventResult.IGNORED,
          payload: event.payload,
        })
        .onConflictDoNothing({ target: webhookEvents.eventId })
        .returning({ eventId: webhookEvents.eventId });
      if (inserted.length === 0) return { duplicate: true };

      let outcome: SettleOutcome;
      if (event.status === ChargeOutcome.APPROVED) {
        if (!event.providerChargeId?.trim()) {
          throw new ValidationError('Missing provider charge ID', [
            { field: 'provider_charge_id', message: 'Required for an approved payment' },
          ]);
        }
        outcome = { status: OperationStatus.COMPLETED, providerChargeId: event.providerChargeId };
      } else {
        outcome = { status: OperationStatus.FAILED, reason: DEFAULT_DECLINE_REASON };
      }
      const settlement = await this.settle(event.operationId, outcome, tx);
      const result = classifyWebhookResult({
        applied: settlement.applied,
        eventStatus: event.status,
        finalStatus: settlement.operation.status,
      });
      await tx
        .update(webhookEvents)
        .set({ result })
        .where(eq(webhookEvents.eventId, event.eventId));
      return { duplicate: false, result, operation: settlement.operation };
    });
  }
}
