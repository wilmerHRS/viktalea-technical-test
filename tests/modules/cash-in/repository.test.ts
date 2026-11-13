import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { env } from '../../../src/config/env.ts';
import { createDb } from '../../../src/shared/infrastructure/db/client.ts';
import type { NewOperation } from '../../../src/modules/cash-in/domain/Operation.ts';
import { DrizzleOperationRepository } from '../../../src/modules/cash-in/infrastructure/persistence/DrizzleOperationRepository.ts';
import { operations, wallets, ledgerEntries, webhookEvents } from '../../../src/modules/cash-in/infrastructure/persistence/schema.ts';

const newOperation = (overrides: Partial<NewOperation> = {}): NewOperation => ({
  id: `op_${randomUUID().replaceAll('-', '')}`, idempotencyKey: randomUUID(), requestHash: 'hash',
  userId: 'user', amountCents: 10000, currency: 'PEN', paymentMethod: 'card', ...overrides,
});
const approved = { status: 'COMPLETED', providerChargeId: 'ch_test' } as const;

describe('DrizzleOperationRepository against PostgreSQL (T4)', { concurrency: false }, () => {
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let repo: DrizzleOperationRepository;
  let other: DrizzleOperationRepository;

  beforeEach(async () => {
    assert.equal(env.DB_NAME, 'cashin_test', 'Destructive fixtures must only use cashin_test');
    first = createDb(env);
    second = createDb(env);
    repo = new DrizzleOperationRepository({ db: first.db });
    other = new DrizzleOperationRepository({ db: second.db });
    await first.db.execute(sql`TRUNCATE webhook_events, ledger_entries, operations, wallets RESTART IDENTITY CASCADE`);
  });
  afterEach(async () => { await Promise.all([first.pool.end(), second.pool.end()]); });

  it('(a) concurrent claims from independent pools create one operation for a global key', async () => {
    const input = newOperation();
    // Different users avoid serializing on the wallet row: the global key itself must arbitrate.
    const results = await Promise.all([repo.claim(input), other.claim(newOperation({
      idempotencyKey: input.idempotencyKey, userId: 'other-user', requestHash: 'different',
    }))]);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(results[0]!.operation.id, results[1]!.operation.id);
    assert.equal(results[0]!.operation.requestHash, results[1]!.operation.requestHash);
    assert.equal((await first.db.select().from(operations)).length, 1);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 0);
    for (const wallet of await first.db.select().from(wallets)) assert.equal(wallet.balanceCents, 0);
  });

  it('(a) same-user, same-payload concurrent claims also return the same operation', async () => {
    const input = newOperation();
    const [a, b] = await Promise.all([repo.claim(input), other.claim({ ...input, id: 'op_other' })]);
    assert.equal(Number(a.created) + Number(b.created), 1);
    assert.equal(a.operation.id, b.operation.id);
    assert.equal((await first.db.select().from(operations)).length, 1);
  });

  it('(b) concurrent settlements credit exactly once and both return the persisted result', async () => {
    const { operation } = await repo.claim(newOperation());
    const results = await Promise.all([repo.settle(operation.id, approved), other.settle(operation.id, approved)]);
    assert.equal(results.filter((r) => r.applied).length, 1);
    for (const result of results) {
      assert.equal(result.operation.status, 'COMPLETED');
      assert.equal(result.operation.newBalanceCents, 10000);
    }
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 10000);
    const ledger = await first.db.select().from(ledgerEntries);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.amountCents, 10000);
  });

  it('(c) final states resist all later settlements and markUnknown', async () => {
    for (const outcome of [approved, { status: 'FAILED', reason: 'declined' } as const]) {
      const { operation } = await repo.claim(newOperation());
      const settled = await repo.settle(operation.id, outcome);
      for (const later of [approved, { status: 'FAILED', reason: 'late' } as const]) {
        const result = await other.settle(operation.id, later);
        assert.equal(result.applied, false);
        assert.deepEqual(result.operation, settled.operation);
      }
      await other.markUnknown(operation.id);
      assert.deepEqual(await repo.findById(operation.id), settled.operation);
    }
  });

  it('(d) 20 concurrent operations on one wallet preserve the exact sum and historical balances', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => newOperation({ amountCents: 101 + i }));
    for (const input of inputs) await repo.claim(input);
    const results = await Promise.all(inputs.map((input, i) => (i % 2 ? repo : other).settle(input.id, approved)));
    assert.ok(results.every((r) => r.applied));
    const expected = inputs.reduce((sum, input) => sum + input.amountCents, 0);
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, expected);
    const ledger = await first.db.select().from(ledgerEntries);
    assert.equal(ledger.length, 20);
    assert.equal(new Set(ledger.map((entry) => entry.balanceAfterCents)).size, 20);
    assert.equal(ledger.reduce((sum, entry) => sum + entry.amountCents, 0), expected);
    for (const input of inputs) {
      const replay = await other.claim(input);
      assert.equal(replay.created, false);
      assert.equal(replay.operation.newBalanceCents, ledger.find((entry) => entry.operationId === input.id)!.balanceAfterCents);
    }
  });

  it('markUnknown only transitions PROCESSING, and UNKNOWN can settle without a second credit', async () => {
    const { operation } = await repo.claim(newOperation());
    await repo.markUnknown(operation.id);
    const unknown = await repo.findById(operation.id);
    assert.equal(unknown?.status, 'UNKNOWN');
    await other.markUnknown(operation.id);
    assert.deepEqual(await repo.findById(operation.id), unknown);
    assert.equal((await repo.settle(operation.id, approved)).operation.newBalanceCents, 10000);
  });

  it('declined settlements never write ledger entries or change the wallet', async () => {
    const { operation } = await repo.claim(newOperation());
    const result = await repo.settle(operation.id, { status: 'FAILED', reason: 'declined' });
    assert.equal(result.applied, true);
    assert.equal(result.operation.failureReason, 'declined');
    assert.equal(result.operation.newBalanceCents, null);
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 0);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 0);
  });

  it('rolls back operation and wallet when the ledger insert fails', async () => {
    const { operation } = await repo.claim(newOperation());
    // Force the unique ledger safety net to reject settlement after the wallet UPDATE.
    await first.db.insert(ledgerEntries).values({ operationId: operation.id, userId: operation.userId,
      amountCents: operation.amountCents, balanceAfterCents: 10000 });
    await assert.rejects(repo.settle(operation.id, approved));
    assert.equal((await repo.findById(operation.id))?.status, 'PROCESSING');
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 0);
  });

  it('deduplicates webhook events atomically across pools', async () => {
    const event = { eventId: 'evt_test', operationId: 'op_test', status: 'approved' as const,
      result: 'ignored' as const, payload: { source: 'test' } };
    const results = await Promise.all([repo.recordWebhookEvent(event), other.recordWebhookEvent(event)]);
    assert.equal(results.filter((r) => r.duplicate).length, 1);
    assert.equal((await first.db.select().from(webhookEvents)).length, 1);
  });

  it('shares the caller transaction for webhook deduplication and settlement', async () => {
    const { operation } = await repo.claim(newOperation());
    const event = { eventId: 'evt_atomic', operationId: operation.id, status: 'approved' as const,
      result: 'ignored' as const, payload: {} };
    await assert.rejects(first.db.transaction(async (tx) => {
      assert.equal((await repo.recordWebhookEvent(event, tx)).duplicate, false);
      await repo.settle(operation.id, approved, tx);
      throw new Error('Force transaction rollback');
    }), /Force transaction rollback/);
    assert.equal((await first.db.select().from(webhookEvents)).length, 0);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 0);
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 0);
    assert.equal((await repo.findById(operation.id))?.status, 'PROCESSING');
    await first.db.transaction(async (tx) => {
      assert.equal((await repo.recordWebhookEvent(event, tx)).duplicate, false);
      await repo.settle(operation.id, approved, tx);
      await tx.update(webhookEvents).set({ result: 'applied' }).where(eq(webhookEvents.eventId, event.eventId));
    });
    assert.equal((await repo.findById(operation.id))?.status, 'COMPLETED');
    assert.equal((await first.db.select().from(webhookEvents))[0]!.result, 'applied');
  });

  it('(e) concurrent leases return disjoint batches; expired leases can be acquired again', async () => {
    for (let i = 0; i < 20; i++) {
      const { operation } = await repo.claim(newOperation());
      await repo.markUnknown(operation.id);
    }
    const before = await first.db.select().from(operations);
    const [a, b] = await Promise.all([repo.leasePendingBatch(30000, 60000, 10), other.leasePendingBatch(30000, 60000, 10)]);
    assert.equal(a.length, 10);
    assert.equal(b.length, 10);
    assert.equal(new Set([...a, ...b].map((op) => op.id)).size, 20);
    assert.deepEqual(await repo.leasePendingBatch(30000, 60000, 10), []);
    for (const op of [...a, ...b]) {
      assert.ok(op.reconcileLockedUntil);
      assert.equal(op.updatedAt.getTime(), before.find((row) => row.id === op.id)!.updatedAt.getTime());
    }
    const expired = a[0]!;
    await first.db.update(operations).set({ reconcileLockedUntil: sql`now() - interval '1 second'` })
      .where(eq(operations.id, expired.id));
    const reacquired = await other.leasePendingBatch(30000, 60000, 10);
    assert.deepEqual(reacquired.map((op) => op.id), [expired.id]);
    assert.ok(reacquired[0]!.reconcileLockedUntil!.getTime() > Date.now());
    // The reservation transaction has committed: another pool can settle immediately.
    await other.settle(expired.id, approved);
    assert.equal((await repo.findById(expired.id))?.status, 'COMPLETED');
  });

  it('leases UNKNOWN and stale PROCESSING, excluding recent, reserved and final operations', async () => {
    const stale = (await repo.claim(newOperation())).operation;
    await first.db.update(operations).set({ updatedAt: sql`now() - interval '2 minutes'` }).where(eq(operations.id, stale.id));
    await repo.claim(newOperation()); // recent PROCESSING
    const unknown = (await repo.claim(newOperation())).operation;
    await repo.markUnknown(unknown.id);
    const final = (await repo.claim(newOperation())).operation;
    await repo.settle(final.id, approved);
    const reserved = (await repo.claim(newOperation())).operation;
    await repo.markUnknown(reserved.id);
    await first.db.update(operations).set({ reconcileLockedUntil: sql`now() + interval '1 minute'` }).where(eq(operations.id, reserved.id));
    const batch = await repo.leasePendingBatch(30000, 60000, 10);
    assert.deepEqual(new Set(batch.map((op) => op.id)), new Set([stale.id, unknown.id]));
    assert.ok(first.pool.idleCount > 0);
    assert.equal(await repo.findById('op_missing'), null);
    await assert.rejects(repo.settle('op_missing', approved), /not found/);
  });
});
