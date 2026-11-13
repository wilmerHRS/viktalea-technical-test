// Integration tests against real PostgreSQL (cashin_test). They live in ONE file on purpose:
// node --test runs files in parallel, and these tests truncate shared tables.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PaymentWebhookEvent } from '../../../src/modules/cash-in/domain/value-objects/payment-webhook-event.value-object.ts';
import { OperationStatus } from '../../../src/modules/cash-in/domain/value-objects/operation-status.value-object.ts';
import { WebhookEventResult } from '../../../src/modules/cash-in/domain/value-objects/webhook-event-result.value-object.ts';
import { ChargeOutcome } from '../../../src/modules/cash-in/domain/gateways/payment-provider.gateway.ts';
import type { LeaseCriteria } from '../../../src/modules/cash-in/domain/repositories/operation.repository.ts';
import {
  ledgerEntries,
  operations,
  wallets,
  webhookEvents,
} from '../../../src/modules/cash-in/infrastructure/persistence/cash-in.tables.ts';
import {
  approvedOutcome,
  closePods,
  createPod,
  declinedOutcome,
  DEFAULT_AMOUNT_CENTS,
  newOperation,
  resetDatabase,
  type CashInPod,
} from '../../fixtures/cash-in-pod.fixture.ts';

describe('cash-in persistence and use cases (PostgreSQL)', { concurrency: false }, () => {
  let podA: CashInPod;
  let podB: CashInPod;

  const allWallets = () => podA.connection.db.select().from(wallets);
  const allLedgerEntries = () => podA.connection.db.select().from(ledgerEntries);
  const allOperations = () => podA.connection.db.select().from(operations);
  const allWebhookEvents = () => podA.connection.db.select().from(webhookEvents);
  const findOperation = (id: string) =>
    podA.unitOfWork.run(({ operations: repository }) => repository.findById(id));
  const walletBalance = async () => (await allWallets())[0]!.balanceCents;

  beforeEach(async () => {
    podA = createPod();
    podB = createPod();
    await resetDatabase(podA);
  });

  afterEach(async () => {
    await closePods(podA, podB);
  });

  describe('ClaimOperation (R2.1, R2.5)', () => {
    it('two pods claiming the same key create one operation', async () => {
      const first = newOperation();
      // Different user and payload: only the global idempotency key must arbitrate.
      const sameKeyOtherPayload = newOperation({
        idempotencyKey: first.idempotencyKey,
        userId: 'other-user',
        requestHash: 'different',
      });

      const results = await Promise.all([
        podA.claimOperation.execute(first),
        podB.claimOperation.execute(sameKeyOtherPayload),
      ]);

      const createdCount = results.filter((result) => result.created).length;
      assert.equal(createdCount, 1);
      assert.equal(results[0]!.operation.id, results[1]!.operation.id);
      assert.equal(results[0]!.operation.requestHash, results[1]!.operation.requestHash);
      assert.equal((await allOperations()).length, 1);
      assert.equal((await allLedgerEntries()).length, 0);
    });

    it('a repeated request returns the existing operation', async () => {
      const request = newOperation();

      const [a, b] = await Promise.all([
        podA.claimOperation.execute(request),
        podB.claimOperation.execute({ ...request, id: 'op_other' }),
      ]);

      assert.equal(Number(a.created) + Number(b.created), 1);
      assert.equal(a.operation.id, b.operation.id);
      assert.equal((await allOperations()).length, 1);
    });
  });

  describe('SettleOperation (R3.4, R6)', () => {
    it('two pods settling the same operation credit it once', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());

      const results = await Promise.all([
        podA.settleOperation.execute(operation.id, approvedOutcome),
        podB.settleOperation.execute(operation.id, approvedOutcome),
      ]);

      const appliedCount = results.filter((result) => result.applied).length;
      assert.equal(appliedCount, 1);
      for (const result of results) {
        assert.equal(result.operation.status, OperationStatus.COMPLETED);
        assert.equal(result.operation.newBalanceCents, DEFAULT_AMOUNT_CENTS);
      }
      assert.equal(await walletBalance(), DEFAULT_AMOUNT_CENTS);
      assert.equal((await allLedgerEntries()).length, 1);
    });

    it('a final status never changes again', async () => {
      for (const firstOutcome of [approvedOutcome, declinedOutcome]) {
        const { operation } = await podA.claimOperation.execute(newOperation());
        const settled = await podA.settleOperation.execute(operation.id, firstOutcome);

        for (const laterOutcome of [approvedOutcome, declinedOutcome]) {
          const later = await podB.settleOperation.execute(operation.id, laterOutcome);
          assert.equal(later.applied, false);
          assert.deepEqual(later.operation, settled.operation);
        }
        await podB.markOperationUnknown.execute(operation.id);
        assert.deepEqual(await findOperation(operation.id), settled.operation);
      }
    });

    it('20 concurrent credits to one wallet keep the exact sum (R6.3)', async () => {
      const requests = Array.from({ length: 20 }, (_, index) =>
        newOperation({ amountCents: 101 + index }),
      );
      for (const request of requests) {
        await podA.claimOperation.execute(request);
      }

      const results = await Promise.all(
        requests.map((request, index) => {
          const pod = index % 2 === 0 ? podA : podB;
          return pod.settleOperation.execute(request.id, approvedOutcome);
        }),
      );

      assert.ok(results.every((result) => result.applied));
      const expectedBalance = requests.reduce((sum, request) => sum + request.amountCents, 0);
      assert.equal(await walletBalance(), expectedBalance);
      const ledger = await allLedgerEntries();
      assert.equal(ledger.length, 20);
      const distinctBalances = new Set(ledger.map((entry) => entry.balanceAfterCents));
      assert.equal(distinctBalances.size, 20);

      // A replay returns the balance recorded for THAT operation, not the current one (R2.2).
      for (const request of requests) {
        const replay = await podB.claimOperation.execute(request);
        const entry = ledger.find((ledgerEntry) => ledgerEntry.operationId === request.id)!;
        assert.equal(replay.created, false);
        assert.equal(replay.operation.newBalanceCents, entry.balanceAfterCents);
      }
    });

    it('a declined payment leaves the wallet and ledger untouched (R1.6)', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());

      const result = await podA.settleOperation.execute(operation.id, declinedOutcome);

      assert.equal(result.applied, true);
      assert.equal(result.operation.status, OperationStatus.FAILED);
      assert.equal(result.operation.newBalanceCents, null);
      assert.equal(await walletBalance(), 0);
      assert.equal((await allLedgerEntries()).length, 0);
    });

    it('a failure in the last step rolls back every step', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());
      // Pre-existing ledger entry: the UNIQUE(operation_id) insert fails AFTER the status
      // change and the wallet credit.
      await podA.connection.db.insert(ledgerEntries).values({
        operationId: operation.id,
        userId: operation.userId,
        amountCents: operation.amountCents,
        balanceAfterCents: DEFAULT_AMOUNT_CENTS,
      });

      await assert.rejects(podA.settleOperation.execute(operation.id, approvedOutcome));

      assert.equal((await findOperation(operation.id))?.status, OperationStatus.PROCESSING);
      assert.equal(await walletBalance(), 0);
    });

    it('rejects an operation that does not exist', async () => {
      await assert.rejects(
        podA.settleOperation.execute('op_missing', approvedOutcome),
        /not found/,
      );
    });
  });

  describe('MarkOperationUnknown (R4.4)', () => {
    it('only moves PROCESSING to UNKNOWN, and UNKNOWN can still be settled once', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());

      await podA.markOperationUnknown.execute(operation.id);
      const unknown = await findOperation(operation.id);
      await podB.markOperationUnknown.execute(operation.id);

      assert.equal(unknown?.status, OperationStatus.UNKNOWN);
      assert.deepEqual(await findOperation(operation.id), unknown);
      const settled = await podA.settleOperation.execute(operation.id, approvedOutcome);
      assert.equal(settled.operation.newBalanceCents, DEFAULT_AMOUNT_CENTS);
    });
  });

  describe('HandlePaymentWebhook (R5)', () => {
    const approvedEvent = (operationId: string, eventId = 'evt_test'): PaymentWebhookEvent => ({
      eventId,
      operationId,
      status: ChargeOutcome.APPROVED,
      providerChargeId: 'ch_webhook',
      payload: { source: 'test' },
    });

    const declinedEvent = (operationId: string, eventId: string): PaymentWebhookEvent => ({
      eventId,
      operationId,
      status: ChargeOutcome.DECLINED,
      payload: {},
    });

    const processed = <T extends { duplicate: boolean }>(result: T) => {
      if (result.duplicate) {
        assert.fail('Expected the event to be processed, not discarded as duplicate');
      }
      return result as Extract<T, { duplicate: false }>;
    };

    it('the same event delivered to two pods has one effect (R5.3)', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());
      const event = approvedEvent(operation.id);

      const results = await Promise.all([
        podA.handlePaymentWebhook.execute(event),
        podB.handlePaymentWebhook.execute(event),
      ]);

      assert.equal(results.filter((result) => result.duplicate).length, 1);
      const winner = processed(results.find((result) => !result.duplicate)!);
      assert.equal(winner.result, WebhookEventResult.APPLIED);
      assert.equal(winner.operation.newBalanceCents, DEFAULT_AMOUNT_CENTS);
      assert.equal((await allWebhookEvents()).length, 1);
      assert.equal((await allLedgerEntries()).length, 1);
      assert.deepEqual(await podB.handlePaymentWebhook.execute(event), { duplicate: true });
    });

    it('if a step fails, neither the event nor its effect is stored (R5.7)', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());
      const event = approvedEvent(operation.id, 'evt_atomic');
      // Real PostgreSQL failure in the LAST step (saving the result).
      await podA.connection.db.execute(sql`
        CREATE FUNCTION pg_temp.fail_result_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Forced webhook result failure'; END; $$;
        CREATE TRIGGER fail_result_update BEFORE UPDATE ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_result_update();
      `);

      try {
        await assert.rejects(podA.handlePaymentWebhook.execute(event));
      } finally {
        await podA.connection.db.execute(sql`DROP TRIGGER fail_result_update ON webhook_events`);
      }

      assert.equal((await allWebhookEvents()).length, 0);
      assert.equal((await allLedgerEntries()).length, 0);
      assert.equal(await walletBalance(), 0);
      assert.equal((await findOperation(operation.id))?.status, OperationStatus.PROCESSING);

      // The provider retries the webhook and this time it works.
      processed(await podB.handlePaymentWebhook.execute(event));
      assert.equal((await findOperation(operation.id))?.status, OperationStatus.COMPLETED);
      assert.equal((await allWebhookEvents())[0]!.result, WebhookEventResult.APPLIED);
    });

    it('a decline over COMPLETED is a conflict and changes nothing (R5.4)', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());
      const completed = await podA.settleOperation.execute(operation.id, approvedOutcome);

      const handled = await podB.handlePaymentWebhook.execute(
        declinedEvent(operation.id, 'evt_conflict'),
      );

      const result = processed(handled);
      assert.equal(result.result, WebhookEventResult.CONFLICT);
      assert.deepEqual(result.operation, completed.operation);
      assert.equal((await allWebhookEvents())[0]!.result, WebhookEventResult.CONFLICT);
      assert.equal(await walletBalance(), DEFAULT_AMOUNT_CENTS);
    });

    it('a late event that agrees with the final status is ignored', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());
      await podA.settleOperation.execute(operation.id, approvedOutcome);

      const handled = await podA.handlePaymentWebhook.execute(
        approvedEvent(operation.id, 'evt_agrees'),
      );

      const result = processed(handled);
      assert.equal(result.result, WebhookEventResult.IGNORED);
      assert.equal(result.operation.providerChargeId, 'ch_test');
      assert.equal((await allLedgerEntries()).length, 1);
    });

    it('a decline event fails the operation without crediting', async () => {
      const { operation } = await podA.claimOperation.execute(newOperation());

      const handled = await podA.handlePaymentWebhook.execute(
        declinedEvent(operation.id, 'evt_declined'),
      );

      const result = processed(handled);
      assert.equal(result.result, WebhookEventResult.APPLIED);
      assert.equal(result.operation.status, OperationStatus.FAILED);
      assert.equal(await walletBalance(), 0);
    });

    it('an event for an unknown operation is rejected and not stored', async () => {
      await assert.rejects(
        podA.handlePaymentWebhook.execute(approvedEvent('op_missing', 'evt_missing')),
        /not found/,
      );
      assert.equal((await allWebhookEvents()).length, 0);
    });
  });

  describe('OperationRepository.leasePendingBatch (R7.3)', () => {
    const criteria: LeaseCriteria = { staleAfterMs: 30_000, leaseMs: 60_000, limit: 10 };
    const lease = (pod: CashInPod) =>
      pod.unitOfWork.run(({ operations: repository }) => repository.leasePendingBatch(criteria));
    const leaseColumnOf = async (id: string) => {
      const [row] = await podA.connection.db
        .select({ lockedUntil: operations.reconcileLockedUntil })
        .from(operations)
        .where(eq(operations.id, id));
      return row!.lockedUntil;
    };

    it('two pods get disjoint batches, and an expired lease can be taken again', async () => {
      for (let index = 0; index < 20; index++) {
        const { operation } = await podA.claimOperation.execute(newOperation());
        await podA.markOperationUnknown.execute(operation.id);
      }
      const updatedAtBefore = new Map(
        (await allOperations()).map((row) => [row.id, row.updatedAt.getTime()]),
      );

      const [batchA, batchB] = await Promise.all([lease(podA), lease(podB)]);

      assert.equal(batchA.length, 10);
      assert.equal(batchB.length, 10);
      const leasedIds = new Set([...batchA, ...batchB].map((operation) => operation.id));
      assert.equal(leasedIds.size, 20);
      assert.deepEqual(await lease(podA), []);
      for (const operation of [...batchA, ...batchB]) {
        assert.ok(await leaseColumnOf(operation.id));
        assert.equal('reconcileLockedUntil' in operation, false);
        assert.equal(operation.updatedAt.getTime(), updatedAtBefore.get(operation.id));
      }

      const expired = batchA[0]!;
      await podA.connection.db
        .update(operations)
        .set({ reconcileLockedUntil: sql`now() - interval '1 second'` })
        .where(eq(operations.id, expired.id));
      const retaken = await lease(podB);

      assert.deepEqual(
        retaken.map((operation) => operation.id),
        [expired.id],
      );
      assert.ok((await leaseColumnOf(expired.id))!.getTime() > Date.now());
      // The reservation already committed: another pod can settle right away.
      await podB.settleOperation.execute(expired.id, approvedOutcome);
      assert.equal((await findOperation(expired.id))?.status, OperationStatus.COMPLETED);
    });

    it('only takes UNKNOWN or stale PROCESSING operations without a live lease', async () => {
      const stale = (await podA.claimOperation.execute(newOperation())).operation;
      await podA.connection.db
        .update(operations)
        .set({ updatedAt: sql`now() - interval '2 minutes'` })
        .where(eq(operations.id, stale.id));
      await podA.claimOperation.execute(newOperation()); // recent PROCESSING: excluded
      const unknown = (await podA.claimOperation.execute(newOperation())).operation;
      await podA.markOperationUnknown.execute(unknown.id);
      const final = (await podA.claimOperation.execute(newOperation())).operation;
      await podA.settleOperation.execute(final.id, approvedOutcome); // final: excluded
      const reserved = (await podA.claimOperation.execute(newOperation())).operation;
      await podA.markOperationUnknown.execute(reserved.id);
      await podA.connection.db
        .update(operations)
        .set({ reconcileLockedUntil: sql`now() + interval '1 minute'` })
        .where(eq(operations.id, reserved.id)); // live lease: excluded

      const batch = await lease(podA);

      const batchIds = new Set(batch.map((operation) => operation.id));
      assert.deepEqual(batchIds, new Set([stale.id, unknown.id]));
    });
  });
});
