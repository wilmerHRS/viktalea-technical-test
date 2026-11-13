import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { NotFoundError } from '../../../../shared/domain/errors/index.ts';
import type { Db, Tx } from '../../../../shared/infrastructure/db/client.ts';
import { Operation, type NewOperation } from '../../domain/Operation.ts';
import type { OperationRepository, SettleOutcome, WebhookEventInput } from '../../domain/OperationRepository.ts';
import type { OperationStatus } from '../../domain/OperationStatus.ts';
import { ledgerEntries, operations, wallets, webhookEvents } from './schema.ts';

type OperationRow = typeof operations.$inferSelect;

const restore = (row: OperationRow, newBalanceCents: number | null = null): Operation =>
  Operation.restore({ ...row, status: row.status as OperationStatus, newBalanceCents });

export class DrizzleOperationRepository implements OperationRepository {
  private readonly db: Db;

  constructor({ db }: { db: Db }) { this.db = db; }

  async claim(input: NewOperation): Promise<{ created: boolean; operation: Operation }> {
    const operation = Operation.create(input);
    return this.db.transaction(async (tx) => {
      await tx.insert(wallets).values({ userId: operation.userId }).onConflictDoNothing();
      const [inserted] = await tx.insert(operations).values({
        ...input, status: operation.status,
      }).onConflictDoNothing({ target: operations.idempotencyKey }).returning();
      if (inserted) return { created: true, operation: restore(inserted) };

      const [existing] = await tx.select({ row: operations, balance: ledgerEntries.balanceAfterCents })
        .from(operations).leftJoin(ledgerEntries, eq(ledgerEntries.operationId, operations.id))
        .where(eq(operations.idempotencyKey, input.idempotencyKey));
      if (!existing) throw new NotFoundError('Cash-in operation not found');
      return { created: false, operation: restore(existing.row, existing.balance) };
    });
  }

  async findById(id: string, tx?: Tx): Promise<Operation | null> {
    const [found] = await (tx ?? this.db).select({ row: operations, balance: ledgerEntries.balanceAfterCents })
      .from(operations).leftJoin(ledgerEntries, eq(ledgerEntries.operationId, operations.id))
      .where(eq(operations.id, id));
    return found ? restore(found.row, found.balance) : null;
  }

  async markUnknown(id: string): Promise<void> {
    await this.db.update(operations).set({ status: 'UNKNOWN', updatedAt: sql`now()` })
      .where(and(eq(operations.id, id), eq(operations.status, 'PROCESSING')));
  }

  async settle(id: string, outcome: SettleOutcome, tx?: Tx): Promise<{ applied: boolean; operation: Operation }> {
    if (!tx) return this.db.transaction((client) => this.settle(id, outcome, client));

    const [changed] = await tx.update(operations).set({
      status: outcome.status,
      providerChargeId: outcome.status === 'COMPLETED' ? outcome.providerChargeId : null,
      failureReason: outcome.status === 'FAILED' ? outcome.reason : null,
      updatedAt: sql`now()`,
    }).where(and(eq(operations.id, id), inArray(operations.status, ['PROCESSING', 'UNKNOWN']))).returning();

    if (!changed) {
      const existing = await this.findById(id, tx);
      if (!existing) throw new NotFoundError('Cash-in operation not found');
      return { applied: false, operation: existing };
    }

    if (outcome.status === 'FAILED') return { applied: true, operation: restore(changed) };

    const [wallet] = await tx.update(wallets).set({
      balanceCents: sql`${wallets.balanceCents} + ${changed.amountCents}`,
      updatedAt: sql`now()`,
    }).where(eq(wallets.userId, changed.userId)).returning({ balance: wallets.balanceCents });
    if (!wallet) throw new NotFoundError('Wallet not found');

    await tx.insert(ledgerEntries).values({ operationId: id, userId: changed.userId,
      amountCents: changed.amountCents, balanceAfterCents: wallet.balance });
    return { applied: true, operation: restore(changed, wallet.balance) };
  }

  async leasePendingBatch(olderThanMs: number, leaseMs: number, limit: number): Promise<Operation[]> {
    // This transaction only reserves rows. It commits before any caller can perform external I/O.
    return this.db.transaction(async (tx) => {
      const candidates = tx.select({ id: operations.id }).from(operations).where(and(
        or(eq(operations.status, 'UNKNOWN'), and(eq(operations.status, 'PROCESSING'),
          lt(operations.updatedAt, sql`now() - ${olderThanMs} * interval '1 millisecond'`))),
        or(isNull(operations.reconcileLockedUntil), lt(operations.reconcileLockedUntil, sql`now()`)),
      )).orderBy(operations.updatedAt).limit(limit).for('update', { skipLocked: true });

      const reserved = await tx.update(operations).set({
        reconcileLockedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
      }).where(inArray(operations.id, candidates)).returning();
      return reserved.map((row) => restore(row));
    });
  }

  async recordWebhookEvent(e: WebhookEventInput, tx?: Tx): Promise<{ duplicate: boolean }> {
    const inserted = await (tx ?? this.db).insert(webhookEvents).values(e)
      .onConflictDoNothing({ target: webhookEvents.eventId }).returning({ eventId: webhookEvents.eventId });
    return { duplicate: inserted.length === 0 };
  }
}
