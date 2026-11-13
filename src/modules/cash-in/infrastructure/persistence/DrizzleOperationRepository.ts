import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { NotFoundError } from '../../../../shared/domain/errors/index.ts';
import type { Db, Tx } from '../../../../shared/infrastructure/db/client.ts';
import { Operation, type NewOperation } from '../../domain/entities/Operation.ts';
import type {
  OperationRepository,
  ClaimResult,
  SettleResult,
  ApplyWebhookEventResult,
} from '../../domain/repositories/OperationRepository.ts';
import type { SettleOutcome } from '../../domain/value-objects/SettleOutcome.ts';
import {
  toSettleOutcome,
  type PaymentWebhookEvent,
} from '../../domain/value-objects/PaymentWebhookEvent.ts';
import {
  OperationStatus,
  SETTLEABLE_STATUSES,
} from '../../domain/value-objects/OperationStatus.ts';
import {
  classifyWebhookResult,
  WebhookEventResult,
} from '../../domain/value-objects/WebhookEventResult.ts';
import { ledgerEntries, operations, wallets, webhookEvents } from './schema.ts';

type OperationRow = typeof operations.$inferSelect;
type Executor = Db | Tx;

interface RepositoryDependencies {
  db: Db;
}

const millisecondsAgo = (ms: number) => sql`now() - ${ms} * interval '1 millisecond'`;
const millisecondsFromNow = (ms: number) => sql`now() + ${ms} * interval '1 millisecond'`;

const toOperation = (row: OperationRow, newBalanceCents: number | null = null): Operation =>
  Operation.restore({ ...row, newBalanceCents });

export class DrizzleOperationRepository implements OperationRepository {
  private readonly db: Db;

  constructor({ db }: RepositoryDependencies) {
    this.db = db;
  }

  private selectOperationWithBalance(executor: Executor) {
    return executor
      .select({ row: operations, balance: ledgerEntries.balanceAfterCents })
      .from(operations)
      .leftJoin(ledgerEntries, eq(ledgerEntries.operationId, operations.id));
  }

  async claim(input: NewOperation): Promise<ClaimResult> {
    return this.db.transaction(async (tx) => {
      await tx.insert(wallets).values({ userId: input.userId }).onConflictDoNothing();
      const [inserted] = await tx
        .insert(operations)
        .values({ ...input, status: OperationStatus.PROCESSING })
        .onConflictDoNothing({ target: operations.idempotencyKey })
        .returning();
      if (inserted) {
        return { created: true, operation: toOperation(inserted) };
      }
      const [existing] = await this.selectOperationWithBalance(tx).where(
        eq(operations.idempotencyKey, input.idempotencyKey),
      );
      if (!existing) {
        throw new NotFoundError('Cash-in operation not found');
      }
      return { created: false, operation: toOperation(existing.row, existing.balance) };
    });
  }

  async findById(id: string): Promise<Operation | null> {
    const [found] = await this.selectOperationWithBalance(this.db).where(eq(operations.id, id));
    return found ? toOperation(found.row, found.balance) : null;
  }

  async markUnknown(id: string): Promise<void> {
    const isOperation = eq(operations.id, id);
    const isProcessing = eq(operations.status, OperationStatus.PROCESSING);
    await this.db
      .update(operations)
      .set({ status: OperationStatus.UNKNOWN, updatedAt: sql`now()` })
      .where(and(isOperation, isProcessing));
  }

  async settle(id: string, outcome: SettleOutcome): Promise<SettleResult> {
    return this.db.transaction((tx) => this.settleInTransaction(tx, id, outcome));
  }

  private async settleInTransaction(
    tx: Tx,
    id: string,
    outcome: SettleOutcome,
  ): Promise<SettleResult> {
    const isOperation = eq(operations.id, id);
    const isSettleable = inArray(operations.status, SETTLEABLE_STATUSES);
    const providerChargeId =
      outcome.status === OperationStatus.COMPLETED ? outcome.providerChargeId : null;
    const failureReason = outcome.status === OperationStatus.FAILED ? outcome.reason : null;
    const [changed] = await tx
      .update(operations)
      .set({
        status: outcome.status,
        providerChargeId,
        failureReason,
        updatedAt: sql`now()`,
      })
      .where(and(isOperation, isSettleable))
      .returning();

    if (!changed) {
      const [existing] = await this.selectOperationWithBalance(tx).where(isOperation);
      if (!existing) {
        throw new NotFoundError('Cash-in operation not found');
      }
      return { applied: false, operation: toOperation(existing.row, existing.balance) };
    }
    if (outcome.status === OperationStatus.FAILED) {
      return { applied: true, operation: toOperation(changed) };
    }
    const [wallet] = await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${changed.amountCents}`,
        updatedAt: sql`now()`,
      })
      .where(eq(wallets.userId, changed.userId))
      .returning({ balance: wallets.balanceCents });
    if (!wallet) {
      throw new NotFoundError('Wallet not found');
    }
    await tx.insert(ledgerEntries).values({
      operationId: id,
      userId: changed.userId,
      amountCents: changed.amountCents,
      balanceAfterCents: wallet.balance,
    });
    return { applied: true, operation: toOperation(changed, wallet.balance) };
  }

  async leasePendingBatch(
    olderThanMs: number,
    leaseMs: number,
    limit: number,
  ): Promise<Operation[]> {
    const isUnknown = eq(operations.status, OperationStatus.UNKNOWN);
    const isProcessing = eq(operations.status, OperationStatus.PROCESSING);
    const isStale = lt(operations.updatedAt, millisecondsAgo(olderThanMs));
    const isStaleProcessing = and(isProcessing, isStale);
    const isUnreserved = isNull(operations.reconcileLockedUntil);
    const isLeaseExpired = lt(operations.reconcileLockedUntil, sql`now()`);
    const isLeaseFree = or(isUnreserved, isLeaseExpired);
    const isPending = or(isUnknown, isStaleProcessing);

    // Commit the reservation before returning, without external I/O or changes to updated_at.
    return this.db.transaction(async (tx) => {
      const candidates = tx
        .select({ id: operations.id })
        .from(operations)
        .where(and(isPending, isLeaseFree))
        .orderBy(operations.updatedAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      const reserved = await tx
        .update(operations)
        .set({ reconcileLockedUntil: millisecondsFromNow(leaseMs) })
        .where(inArray(operations.id, candidates))
        .returning();
      return reserved.map((row) => toOperation(row));
    });
  }

  async applyWebhookEvent(event: PaymentWebhookEvent): Promise<ApplyWebhookEventResult> {
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
      if (inserted.length === 0) {
        return { duplicate: true };
      }
      const outcome = toSettleOutcome(event);
      const settlement = await this.settleInTransaction(tx, event.operationId, outcome);
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
