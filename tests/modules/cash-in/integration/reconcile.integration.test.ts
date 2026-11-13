// Reconciliador (R7, R8.2) contra PostgreSQL real (cashin_test).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { createCashInReconciler } from '../../../../src/modules/cash-in/cash-in.module.ts';
import { CHARGE_NOT_FOUND_REASON } from '../../../../src/modules/cash-in/application/constants/reconcile.constants.ts';
import { ChargeOutcome } from '../../../../src/modules/cash-in/domain/gateways/payment-provider.gateway.ts';
import { Currency } from '../../../../src/modules/cash-in/domain/value-objects/currency.value-object.ts';
import { OperationStatus } from '../../../../src/modules/cash-in/domain/value-objects/operation-status.value-object.ts';
import { operations } from '../../../../src/modules/cash-in/infrastructure/persistence/tables/cash-in.tables.ts';
import {
  FakePaymentMethod,
  FakePaymentProvider,
} from '../../../../src/modules/cash-in/infrastructure/providers/fake-payment.provider.ts';
import {
  closePods,
  createPod,
  DEFAULT_AMOUNT_CENTS,
  newOperation,
  resetDatabase,
  type CashInPod,
} from '../../../fixtures/cash-in-pod.fixture.ts';

const STALE_AFTER_MS = 30_000;
const LEASE_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 1_000;
const WEBHOOK_MAX_WAIT_MS = 2_000;
const silentLogger = pino({ level: 'silent' });

describe('ReconcileOperations (R7)', { concurrency: false }, () => {
  let podA: CashInPod;
  let podB: CashInPod;
  let provider: FakePaymentProvider;

  const reconcilerFor = (pod: CashInPod) =>
    createCashInReconciler({
      db: pod.connection.db,
      paymentProvider: provider,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      staleAfterMs: STALE_AFTER_MS,
      leaseMs: LEASE_MS,
      logger: silentLogger,
    });

  const findOperation = (id: string) =>
    podA.unitOfWork.run(({ operations: repository }) => repository.findById(id));

  /** Reproduce la pregunta central: la pasarela cobra, pero la respuesta se pierde. */
  const createUnknownChargedOperation = async (): Promise<string> => {
    const request = newOperation({ paymentMethod: FakePaymentMethod.TIMEOUT_AFTER_CHARGE });
    const { operation } = await podA.claimOperation.execute(request);
    await assert.rejects(
      provider.charge({
        idempotencyKey: operation.id,
        amountCents: operation.amountCents,
        currency: Currency.PEN,
        paymentMethod: operation.paymentMethod,
      }),
    );
    await podA.markOperationUnknown.execute(operation.id);
    return operation.id;
  };

  /** Reproduce un reinicio del pod antes de cobrar: PROCESSING antigua que la pasarela no conoce. */
  const createStuckProcessingOperation = async (): Promise<string> => {
    const { operation } = await podA.claimOperation.execute(newOperation());
    await podA.connection.db
      .update(operations)
      .set({ updatedAt: sql`now() - interval '5 minutes'` })
      .where(eq(operations.id, operation.id));
    return operation.id;
  };

  beforeEach(async () => {
    podA = createPod();
    podB = createPod();
    provider = new FakePaymentProvider();
    await resetDatabase(podA);
  });

  afterEach(async () => {
    await closePods(podA, podB);
  });

  it('cobro hecho pero respuesta perdida: la acredita una vez (pregunta central)', async () => {
    const operationId = await createUnknownChargedOperation();

    const summary = await reconcilerFor(podA).execute();

    assert.deepEqual(summary, { reserved: 1, completed: 1, failed: 0, stillPending: 0, errors: 0 });
    const operation = await findOperation(operationId);
    assert.equal(operation?.status, OperationStatus.COMPLETED);
    assert.equal(operation?.newBalanceCents, DEFAULT_AMOUNT_CENTS);
    assert.equal(provider.chargeCalls(operationId), 1);
  });

  it('pod reiniciado antes de cobrar: la pasarela no la conoce y queda FAILED (R8.2)', async () => {
    const operationId = await createStuckProcessingOperation();

    const summary = await reconcilerFor(podA).execute();

    assert.equal(summary.failed, 1);
    const operation = await findOperation(operationId);
    assert.equal(operation?.status, OperationStatus.FAILED);
    assert.equal(operation?.failureReason, CHARGE_NOT_FOUND_REASON);
    assert.equal(operation?.newBalanceCents, null);
  });

  it('no toca operaciones PROCESSING recientes (siguen en curso en otro pod)', async () => {
    const { operation } = await podA.claimOperation.execute(newOperation());

    const summary = await reconcilerFor(podA).execute();

    assert.equal(summary.reserved, 0);
    assert.equal(provider.statusChecks(operation.id), 0);
    assert.equal((await findOperation(operation.id))?.status, OperationStatus.PROCESSING);
  });

  it('dos pods a la vez: cada operación se consulta y se liquida una sola vez (R7.3)', async () => {
    const operationIds: string[] = [];
    for (let index = 0; index < 6; index++) {
      operationIds.push(await createUnknownChargedOperation());
    }

    const [summaryA, summaryB] = await Promise.all([
      reconcilerFor(podA).execute(),
      reconcilerFor(podB).execute(),
    ]);

    assert.equal(summaryA.reserved + summaryB.reserved, 6);
    assert.equal(summaryA.completed + summaryB.completed, 6);
    for (const operationId of operationIds) {
      assert.equal(provider.statusChecks(operationId), 1);
      const operation = await findOperation(operationId);
      assert.equal(operation?.status, OperationStatus.COMPLETED);
    }
  });

  it('la consulta a la pasarela no bloquea un webhook de la misma operación', async () => {
    const operationId = await createUnknownChargedOperation();
    provider.setStatusDelay(500);

    // Mientras el reconciliador espera a la pasarela, llega el webhook de esa operación.
    const reconciliation = reconcilerFor(podA).execute();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webhook = podB.handlePaymentWebhook.execute({
      eventId: 'evt_during_reconcile',
      operationId,
      status: ChargeOutcome.APPROVED,
      providerChargeId: 'ch_webhook',
      payload: {},
    });
    const webhookTimeout = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('webhook blocked by a lock')), WEBHOOK_MAX_WAIT_MS),
    );

    // Si el reconciliador tuviera una transacción abierta, el webhook se quedaría esperando.
    const handled = await Promise.race([webhook, webhookTimeout]);
    assert.equal((handled as { duplicate: boolean }).duplicate, false);
    const summary = await reconciliation;

    assert.equal(summary.completed, 1); // settle ya no aplica nada, pero el estado final es COMPLETED
    const operation = await findOperation(operationId);
    assert.equal(operation?.newBalanceCents, DEFAULT_AMOUNT_CENTS);
  });

  it('una operación ya reservada por otro pod no se vuelve a consultar hasta que vence', async () => {
    const operationId = await createUnknownChargedOperation();
    await podA.connection.db
      .update(operations)
      .set({ reconcileLockedUntil: sql`now() + interval '1 minute'` })
      .where(eq(operations.id, operationId));

    const summary = await reconcilerFor(podA).execute();

    assert.equal(summary.reserved, 0);
    assert.equal(provider.statusChecks(operationId), 0);
  });
});
