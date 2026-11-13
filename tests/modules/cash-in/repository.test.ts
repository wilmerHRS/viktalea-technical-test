import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { env } from '../../../src/config/env.ts';
import { createDb } from '../../../src/shared/infrastructure/db/client.ts';
import type { NewOperation } from '../../../src/modules/cash-in/domain/entities/Operation.ts';
import type { PaymentWebhookEvent } from '../../../src/modules/cash-in/domain/value-objects/PaymentWebhookEvent.ts';
import { DrizzleOperationRepository } from '../../../src/modules/cash-in/infrastructure/persistence/DrizzleOperationRepository.ts';
import {
  operations,
  wallets,
  ledgerEntries,
  webhookEvents,
} from '../../../src/modules/cash-in/infrastructure/persistence/schema.ts';

const newOperation = (overrides: Partial<NewOperation> = {}): NewOperation => ({
  id: `op_${randomUUID().replaceAll('-', '')}`,
  idempotencyKey: randomUUID(),
  requestHash: 'hash',
  userId: 'user',
  amountCents: 10000,
  currency: 'PEN',
  paymentMethod: 'card',
  ...overrides,
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
    await first.db.execute(
      sql`TRUNCATE webhook_events, ledger_entries, operations, wallets RESTART IDENTITY CASCADE`,
    );
  });
  afterEach(async () => {
    await Promise.all([first.pool.end(), second.pool.end()]);
  });

  it('(a) independent pools claim one global key', async () => {
    const input = newOperation();
    // Different users avoid serializing on the wallet row: the global key itself must arbitrate.
    const results = await Promise.all([
      repo.claim(input),
      other.claim(
        newOperation({
          idempotencyKey: input.idempotencyKey,
          userId: 'other-user',
          requestHash: 'different',
        }),
      ),
    ]);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(results[0]!.operation.id, results[1]!.operation.id);
    assert.equal(results[0]!.operation.requestHash, results[1]!.operation.requestHash);
    assert.equal((await first.db.select().from(operations)).length, 1);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 0);
    for (const wallet of await first.db.select().from(wallets)) {
      assert.equal(wallet.balanceCents, 0);
    }
  });

  it('(a) same-user, same-payload concurrent claims also return the same operation', async () => {
    const input = newOperation();
    const [a, b] = await Promise.all([
      repo.claim(input),
      other.claim({ ...input, id: 'op_other' }),
    ]);
    assert.equal(Number(a.created) + Number(b.created), 1);
    assert.equal(a.operation.id, b.operation.id);
    assert.equal((await first.db.select().from(operations)).length, 1);
  });

  it('(b) concurrent settlements return one persisted credit', async () => {
    const { operation } = await repo.claim(newOperation());
    const results = await Promise.all([
      repo.settle(operation.id, approved),
      other.settle(operation.id, approved),
    ]);
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

  it('(d) 20 concurrent credits preserve the sum and historical balances', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => newOperation({ amountCents: 101 + i }));
    for (const input of inputs) {
      await repo.claim(input);
    }
    const results = await Promise.all(
      inputs.map((input, i) => (i % 2 ? repo : other).settle(input.id, approved)),
    );
    assert.ok(results.every((r) => r.applied));
    const expected = inputs.reduce((sum, input) => sum + input.amountCents, 0);
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, expected);
    const ledger = await first.db.select().from(ledgerEntries);
    assert.equal(ledger.length, 20);
    assert.equal(new Set(ledger.map((entry) => entry.balanceAfterCents)).size, 20);
    assert.equal(
      ledger.reduce((sum, entry) => sum + entry.amountCents, 0),
      expected,
    );
    for (const input of inputs) {
      const replay = await other.claim(input);
      assert.equal(replay.created, false);
      assert.equal(
        replay.operation.newBalanceCents,
        ledger.find((entry) => entry.operationId === input.id)!.balanceAfterCents,
      );
    }
  });

  it('markUnknown is conditional and UNKNOWN can settle once', async () => {
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
    await first.db.insert(ledgerEntries).values({
      operationId: operation.id,
      userId: operation.userId,
      amountCents: operation.amountCents,
      balanceAfterCents: 10000,
    });
    await assert.rejects(repo.settle(operation.id, approved));
    assert.equal((await repo.findById(operation.id))?.status, 'PROCESSING');
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 0);
  });

  it('deduplicates webhook events atomically across pools', async () => {
    const { operation } = await repo.claim(newOperation());
    const event: PaymentWebhookEvent = {
      eventId: 'evt_test',
      operationId: operation.id,
      status: 'approved',
      providerChargeId: 'ch_webhook',
      payload: { source: 'test' },
    };
    const results = await Promise.all([
      repo.applyWebhookEvent(event),
      other.applyWebhookEvent(event),
    ]);
    assert.equal(results.filter((r) => r.duplicate).length, 1);
    const winner = results.find((r) => !r.duplicate)!;
    assert.equal(winner.result, 'applied');
    assert.equal(winner.operation.status, 'COMPLETED');
    assert.equal(winner.operation.newBalanceCents, 10000);
    assert.equal((await first.db.select().from(webhookEvents)).length, 1);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 1);
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 10000);
    assert.deepEqual(await other.applyWebhookEvent(event), { duplicate: true });
  });

  it('rolls back all effects when saving the webhook result fails', async () => {
    const { operation } = await repo.claim(newOperation());
    const event: PaymentWebhookEvent = {
      eventId: 'evt_atomic',
      operationId: operation.id,
      status: 'approved',
      providerChargeId: 'ch_atomic',
      payload: {},
    };
    // Real PostgreSQL fault after settle has updated the operation, wallet and ledger.
    await first.db.execute(sql`
      CREATE FUNCTION pg_temp.fail_webhook_result_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Forced webhook result failure'; END; $$;
      CREATE TRIGGER fail_webhook_result_update BEFORE UPDATE ON webhook_events
      FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_webhook_result_update();
    `);
    try {
      await assert.rejects(repo.applyWebhookEvent(event));
    } finally {
      await first.db.execute(sql`DROP TRIGGER fail_webhook_result_update ON webhook_events`);
    }
    assert.equal((await first.db.select().from(webhookEvents)).length, 0);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 0);
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 0);
    assert.equal((await repo.findById(operation.id))?.status, 'PROCESSING');
    const retried = await other.applyWebhookEvent(event);
    assert.equal(retried.duplicate, false);
    assert.equal((await repo.findById(operation.id))?.status, 'COMPLETED');
    assert.equal((await first.db.select().from(webhookEvents))[0]!.result, 'applied');
  });

  it('declined over COMPLETED is a conflict and preserves the response', async () => {
    const { operation } = await repo.claim(newOperation());
    const final = await repo.settle(operation.id, approved);
    const result = await other.applyWebhookEvent({
      eventId: 'evt_conflict',
      operationId: operation.id,
      status: 'declined',
      payload: {},
    });
    assert.equal(result.duplicate, false);
    if (result.duplicate) {
      assert.fail('First event must be processed');
    }
    assert.equal(result.result, 'conflict');
    assert.deepEqual(result.operation, final.operation);
    assert.equal((await first.db.select().from(webhookEvents))[0]!.result, 'conflict');
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 10000);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 1);
  });

  it('records an agreeing final event as ignored', async () => {
    const { operation } = await repo.claim(newOperation());
    await repo.settle(operation.id, approved);
    const result = await repo.applyWebhookEvent({
      eventId: 'evt_agrees',
      operationId: operation.id,
      status: 'approved',
      providerChargeId: 'ch_later',
      payload: {},
    });
    assert.equal(result.duplicate, false);
    if (result.duplicate) {
      assert.fail('First event must be processed');
    }
    assert.equal(result.result, 'ignored');
    assert.equal(result.operation.providerChargeId, approved.providerChargeId);
    assert.equal((await first.db.select().from(webhookEvents))[0]!.result, 'ignored');
    assert.equal((await first.db.select().from(ledgerEntries)).length, 1);
  });

  it('applies a decline without creating a credit', async () => {
    const { operation } = await repo.claim(newOperation());
    const result = await repo.applyWebhookEvent({
      eventId: 'evt_declined',
      operationId: operation.id,
      status: 'declined',
      payload: {},
    });
    assert.equal(result.duplicate, false);
    if (result.duplicate) {
      assert.fail('First event must be processed');
    }
    assert.equal(result.result, 'applied');
    assert.equal(result.operation.status, 'FAILED');
    assert.equal((await first.db.select().from(wallets))[0]!.balanceCents, 0);
    assert.equal((await first.db.select().from(ledgerEntries)).length, 0);
  });

  it('leaves no webhook record for an unknown operation', async () => {
    await assert.rejects(
      repo.applyWebhookEvent({
        eventId: 'evt_missing',
        operationId: 'op_missing',
        status: 'approved',
        providerChargeId: 'ch_missing',
        payload: {},
      }),
      /not found/,
    );
    assert.equal((await first.db.select().from(webhookEvents)).length, 0);
  });

  it('(e) concurrent leases are disjoint and expired leases can be reacquired', async () => {
    for (let i = 0; i < 20; i++) {
      const { operation } = await repo.claim(newOperation());
      await repo.markUnknown(operation.id);
    }
    const before = await first.db.select().from(operations);
    const [a, b] = await Promise.all([
      repo.leasePendingBatch(30000, 60000, 10),
      other.leasePendingBatch(30000, 60000, 10),
    ]);
    assert.equal(a.length, 10);
    assert.equal(b.length, 10);
    assert.equal(new Set([...a, ...b].map((op) => op.id)).size, 20);
    assert.deepEqual(await repo.leasePendingBatch(30000, 60000, 10), []);
    for (const op of [...a, ...b]) {
      const [persisted] = await first.db.select().from(operations).where(eq(operations.id, op.id));
      assert.ok(persisted!.reconcileLockedUntil);
      assert.equal('reconcileLockedUntil' in op, false);
      assert.equal(
        op.updatedAt.getTime(),
        before.find((row) => row.id === op.id)!.updatedAt.getTime(),
      );
    }
    const expired = a[0]!;
    await first.db
      .update(operations)
      .set({ reconcileLockedUntil: sql`now() - interval '1 second'` })
      .where(eq(operations.id, expired.id));
    const reacquired = await other.leasePendingBatch(30000, 60000, 10);
    assert.deepEqual(
      reacquired.map((op) => op.id),
      [expired.id],
    );
    const [persisted] = await first.db
      .select()
      .from(operations)
      .where(eq(operations.id, expired.id));
    assert.ok(persisted!.reconcileLockedUntil!.getTime() > Date.now());
    // The reservation transaction has committed: another pool can settle immediately.
    await other.settle(expired.id, approved);
    assert.equal((await repo.findById(expired.id))?.status, 'COMPLETED');
  });

  it('leases only eligible UNKNOWN or stale PROCESSING operations', async () => {
    const stale = (await repo.claim(newOperation())).operation;
    await first.db
      .update(operations)
      .set({ updatedAt: sql`now() - interval '2 minutes'` })
      .where(eq(operations.id, stale.id));
    await repo.claim(newOperation()); // recent PROCESSING
    const unknown = (await repo.claim(newOperation())).operation;
    await repo.markUnknown(unknown.id);
    const final = (await repo.claim(newOperation())).operation;
    await repo.settle(final.id, approved);
    const reserved = (await repo.claim(newOperation())).operation;
    await repo.markUnknown(reserved.id);
    await first.db
      .update(operations)
      .set({ reconcileLockedUntil: sql`now() + interval '1 minute'` })
      .where(eq(operations.id, reserved.id));
    const batch = await repo.leasePendingBatch(30000, 60000, 10);
    assert.deepEqual(new Set(batch.map((op) => op.id)), new Set([stale.id, unknown.id]));
    assert.ok(first.pool.idleCount > 0);
    assert.equal(await repo.findById('op_missing'), null);
    await assert.rejects(repo.settle('op_missing', approved), /not found/);
  });
});
