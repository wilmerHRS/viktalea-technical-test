// Tests de las APIs POST /cash-in y POST /webhooks/payment contra PostgreSQL real (cashin_test).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../src/app.ts';
import { env } from '../../../src/config/env.config.ts';
import { createCashInModule } from '../../../src/modules/cash-in/cash-in.module.ts';
import { signPayload } from '../../../src/modules/cash-in/infrastructure/http/webhook-signature.util.ts';
import {
  FakePaymentMethod,
  FakePaymentProvider,
} from '../../../src/modules/cash-in/infrastructure/provider/fake-payment.provider.ts';
import {
  ledgerEntries,
  operations,
  wallets,
} from '../../../src/modules/cash-in/infrastructure/persistence/cash-in.tables.ts';
import { createDb } from '../../../src/shared/infrastructure/db/db.client.ts';
import {
  closePods,
  createPod,
  resetDatabase,
  type CashInPod,
} from '../../fixtures/cash-in-pod.fixture.ts';

const PROVIDER_TIMEOUT_MS = 1_000;
const CLOSED_PORT = 1;
const silentLogger = pino({ level: 'silent' });

const cashInBody = (overrides: Record<string, unknown> = {}) => ({
  user_id: 'usr_abc123',
  amount: 100,
  currency: 'PEN',
  payment_method: 'card_xyz',
  ...overrides,
});

const buildApp = (pod: CashInPod, paymentProvider: FakePaymentProvider): Express =>
  createApp(
    [
      createCashInModule({
        db: pod.connection.db,
        paymentProvider,
        webhookSecret: env.WEBHOOK_SECRET,
        providerTimeoutMs: PROVIDER_TIMEOUT_MS,
        logger: silentLogger,
      }),
    ],
    { logger: silentLogger },
  );

const postCashIn = (app: Express, idempotencyKey: string, body: object) =>
  request(app).post('/cash-in').set('Idempotency-Key', idempotencyKey).send(body);

const postWebhook = (app: Express, payload: object, secret = env.WEBHOOK_SECRET) => {
  const rawBody = JSON.stringify(payload);
  return request(app)
    .post('/webhooks/payment')
    .set('Content-Type', 'application/json')
    .set('X-Signature', signPayload(rawBody, secret))
    .send(rawBody);
};

describe('HTTP API: POST /cash-in y POST /webhooks/payment', { concurrency: false }, () => {
  let pod: CashInPod;
  let provider: FakePaymentProvider;
  let app: Express;

  const countRows = async (table: typeof operations | typeof ledgerEntries) =>
    (await pod.connection.db.select().from(table)).length;
  const walletBalance = async () =>
    (await pod.connection.db.select().from(wallets))[0]!.balanceCents;
  const operationByKey = async (idempotencyKey: string) => {
    const [row] = await pod.connection.db
      .select()
      .from(operations)
      .where(eq(operations.idempotencyKey, idempotencyKey));
    return row;
  };

  beforeEach(async () => {
    pod = createPod();
    provider = new FakePaymentProvider();
    app = buildApp(pod, provider);
    await resetDatabase(pod);
  });

  afterEach(async () => {
    await closePods(pod);
  });

  describe('POST /cash-in', () => {
    it('éxito: 200 con el contrato del challenge y saldo acreditado (R1.5)', async () => {
      const response = await postCashIn(app, randomUUID(), cashInBody()).expect(200);

      assert.match(response.body.operation_id, /^op_[0-9a-f]{32}$/);
      assert.deepEqual(
        { ...response.body, operation_id: undefined },
        { operation_id: undefined, status: 'completed', amount: 100, new_balance: 100 },
      );
      assert.equal(await walletBalance(), 10_000);
    });

    it('replay con la misma key: misma respuesta y un solo cobro (R2.2)', async () => {
      const key = randomUUID();

      const first = await postCashIn(app, key, cashInBody()).expect(200);
      const replay = await postCashIn(app, key, cashInBody()).expect(200);

      assert.deepEqual(replay.body, first.body);
      assert.equal(provider.chargeCalls(first.body.operation_id), 1);
      assert.equal(await countRows(ledgerEntries), 1);
    });

    it('misma key con otro payload: 422 y nada cambia (R2.4)', async () => {
      const key = randomUUID();
      await postCashIn(app, key, cashInBody()).expect(200);

      const response = await postCashIn(app, key, cashInBody({ amount: 50 })).expect(422);

      assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(await countRows(operations), 1);
      assert.equal(await walletBalance(), 10_000);
    });

    it('Idempotency-Key ausente o inválida: 400 (R1.2)', async () => {
      const missing = await request(app).post('/cash-in').send(cashInBody()).expect(400);
      const notUuid = await postCashIn(app, 'not-a-uuid', cashInBody()).expect(400);

      assert.equal(missing.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
      assert.equal(notUuid.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
    });

    it('body inválido: 400 con el detalle por campo (R1.3)', async () => {
      const invalidBodies = [
        cashInBody({ amount: 1.005 }),
        cashInBody({ amount: -1 }),
        cashInBody({ currency: 'USD' }),
        cashInBody({ user_id: '' }),
        { amount: 100 },
      ];

      for (const body of invalidBodies) {
        const response = await postCashIn(app, randomUUID(), body).expect(400);
        assert.equal(response.body.error.code, 'VALIDATION_ERROR');
        assert.ok(response.body.error.details.length > 0);
      }
      assert.equal(await countRows(operations), 0);
    });

    it('pasarela rechaza: 402 failed y el saldo no cambia (R1.6)', async () => {
      const body = cashInBody({ payment_method: FakePaymentMethod.DECLINED });

      const response = await postCashIn(app, randomUUID(), body).expect(402);

      assert.equal(response.body.status, 'failed');
      assert.equal(response.body.failure_reason, 'Payment declined');
      assert.equal(await walletBalance(), 0);
    });

    it('pasarela caída: 202 pending sin reintentar el cobro (R4.4)', async () => {
      const body = cashInBody({ payment_method: FakePaymentMethod.UNAVAILABLE });

      const response = await postCashIn(app, randomUUID(), body).expect(202);

      assert.equal(response.body.status, 'pending');
      assert.equal(provider.chargeCalls(response.body.operation_id), 1);
    });
  });

  describe('pregunta central: timeout después de cobrar', () => {
    it('202 pending, el cliente reintenta sin doble cobro y el webhook lo resuelve', async () => {
      const key = randomUUID();
      const body = cashInBody({ payment_method: FakePaymentMethod.TIMEOUT_AFTER_CHARGE });

      // 1. La pasarela cobra pero no responde a tiempo: no sabemos si cobró.
      const pending = await postCashIn(app, key, body).expect(202);
      assert.equal(pending.headers['retry-after'], '2');
      const operationId: string = pending.body.operation_id;
      assert.equal((await operationByKey(key))!.status, 'UNKNOWN');

      // 2. El cliente reintenta con la misma key: NO se vuelve a cobrar.
      await postCashIn(app, key, body).expect(202);
      assert.equal(provider.chargeCalls(operationId), 1);

      // 3. Llega el webhook de la pasarela con el resultado real.
      const webhook = await postWebhook(app, {
        event_id: 'evt_1',
        operation_id: operationId,
        status: 'approved',
        provider_charge_id: 'ch_1',
      }).expect(200);
      assert.equal(webhook.body.result, 'applied');

      // 4. El siguiente reintento ya devuelve el resultado final, acreditado una sola vez.
      const final = await postCashIn(app, key, body).expect(200);
      assert.equal(final.body.new_balance, 100);
      assert.equal(await countRows(ledgerEntries), 1);
    });
  });

  describe('POST /webhooks/payment', () => {
    const createPendingOperation = async (): Promise<string> => {
      const body = cashInBody({ payment_method: FakePaymentMethod.TIMEOUT });
      const response = await postCashIn(app, randomUUID(), body).expect(202);
      return response.body.operation_id;
    };

    it('firma inválida o ausente: 401 sin procesar nada (R5.2)', async () => {
      const operationId = await createPendingOperation();
      const payload = { event_id: 'evt', operation_id: operationId, status: 'declined' };

      await postWebhook(app, payload, 'wrong_secret_wrong_secret').expect(401);
      await request(app).post('/webhooks/payment').send(payload).expect(401);

      assert.equal((await pod.connection.db.select().from(operations))[0]!.status, 'UNKNOWN');
    });

    it('evento duplicado: un solo efecto (R5.3)', async () => {
      const operationId = await createPendingOperation();
      const payload = {
        event_id: 'evt_dup',
        operation_id: operationId,
        status: 'approved',
        provider_charge_id: 'ch_dup',
      };

      await postWebhook(app, payload).expect(200);
      const duplicate = await postWebhook(app, payload).expect(200);

      assert.deepEqual(duplicate.body, { received: true, duplicate: true });
      assert.equal(await countRows(ledgerEntries), 1);
    });

    it('fuera de orden: declined tras COMPLETED es conflict y no cambia nada (R5.4)', async () => {
      const operationId = await createPendingOperation();
      await postWebhook(app, {
        event_id: 'evt_ok',
        operation_id: operationId,
        status: 'approved',
        provider_charge_id: 'ch_ok',
      }).expect(200);

      const late = await postWebhook(app, {
        event_id: 'evt_late',
        operation_id: operationId,
        status: 'declined',
      }).expect(200);

      assert.equal(late.body.result, 'conflict');
      assert.equal(await walletBalance(), 10_000);
    });

    it('aprobación sin provider_charge_id: 400 (R5.1)', async () => {
      const operationId = await createPendingOperation();

      const response = await postWebhook(app, {
        event_id: 'evt_no_charge',
        operation_id: operationId,
        status: 'approved',
      }).expect(400);

      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    });

    it('operación inexistente: 404 (R5.6)', async () => {
      await postWebhook(app, {
        event_id: 'evt_missing',
        operation_id: 'op_missing',
        status: 'declined',
      }).expect(404);
    });

    it('webhook antes que la respuesta de la API: se acredita una sola vez (R5.5)', async () => {
      const key = randomUUID();
      provider.setDelay(500);

      // La request queda esperando a la pasarela…
      const cashIn = postCashIn(app, key, cashInBody()).then((response) => response);
      let operation = await operationByKey(key);
      while (!operation) {
        await sleep(10);
        operation = await operationByKey(key);
      }
      // …y mientras tanto llega el webhook y liquida la operación.
      await postWebhook(app, {
        event_id: 'evt_early',
        operation_id: operation.id,
        status: 'approved',
        provider_charge_id: 'ch_early',
      }).expect(200);

      const response = await cashIn;
      assert.equal(response.status, 200);
      assert.equal(response.body.new_balance, 100);
      assert.equal(await countRows(ledgerEntries), 1);
      assert.equal(await walletBalance(), 10_000);
    });
  });

  describe('varios pods (R2.5)', () => {
    it('10 requests con la misma key repartidas en 3 pods: una operación y un cobro', async () => {
      const otherPods = [createPod(), createPod()];
      const apps = [app, ...otherPods.map((otherPod) => buildApp(otherPod, provider))];
      const key = randomUUID();

      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            postCashIn(apps[index % apps.length]!, key, cashInBody()),
          ),
        );

        const operationIds = new Set(responses.map((response) => response.body.operation_id));
        assert.equal(operationIds.size, 1);
        for (const response of responses) {
          assert.ok([200, 202].includes(response.status), `status ${response.status}`);
          if (response.status === 200) {
            assert.equal(response.body.new_balance, 100);
          }
        }
        const [operationId] = [...operationIds];
        assert.equal(provider.chargeCalls(operationId), 1);
        assert.equal(await countRows(operations), 1);
        assert.equal(await countRows(ledgerEntries), 1);
        assert.equal(await walletBalance(), 10_000);
      } finally {
        await closePods(...otherPods);
      }
    });
  });

  describe('base de datos caída (R8.1)', () => {
    it('responde 503 con un código claro, no 500', async () => {
      const unreachable = createDb({ ...env, DB_PORT: CLOSED_PORT });
      const brokenApp = createApp(
        [
          createCashInModule({
            db: unreachable.db,
            paymentProvider: provider,
            webhookSecret: env.WEBHOOK_SECRET,
            providerTimeoutMs: PROVIDER_TIMEOUT_MS,
            logger: silentLogger,
          }),
        ],
        { logger: silentLogger },
      );

      try {
        const response = await postCashIn(brokenApp, randomUUID(), cashInBody()).expect(503);
        assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE');
        assert.equal(response.headers['retry-after'], '5');
      } finally {
        await unreachable.pool.end();
      }
    });
  });
});
