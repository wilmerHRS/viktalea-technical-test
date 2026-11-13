import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../../../src/app.ts';
import { env } from '../../../../src/config/env.config.ts';
import { createCashInModule } from '../../../../src/modules/cash-in/cash-in.module.ts';
import { FakePaymentProvider } from '../../../../src/modules/cash-in/infrastructure/providers/fake-payment.provider.ts';
import { createDb } from '../../../../src/shared/infrastructure/db/db.client.ts';

const silentLogger = pino({ level: 'silent' });

describe('Documentación OpenAPI / Swagger', () => {
  // El pool no abre conexiones hasta la primera consulta: aquí no se toca la base de datos.
  const connection = createDb(env);
  const app = createApp(
    [
      createCashInModule({
        db: connection.db,
        paymentProvider: new FakePaymentProvider(),
        webhookSecret: env.WEBHOOK_SECRET,
        providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
        logger: silentLogger,
      }),
    ],
    { logger: silentLogger },
  );

  after(async () => {
    await connection.pool.end();
  });

  it('GET /docs/openapi.json: OpenAPI 3.1 con las dos APIs del challenge', async () => {
    const response = await request(app).get('/docs/openapi.json').expect(200);
    const document = response.body;

    assert.equal(document.openapi, '3.1.0');
    assert.ok(document.paths['/cash-in'].post);
    assert.ok(document.paths['/webhooks/payment'].post);
    const cashInResponses = Object.keys(document.paths['/cash-in'].post.responses);
    assert.deepEqual(cashInResponses.sort(), ['200', '202', '400', '402', '422', '503']);
    assert.ok(document.components.securitySchemes.WebhookSignature);
  });

  it('los esquemas de los bodies salen de los validadores zod de la API', async () => {
    const response = await request(app).get('/docs/openapi.json').expect(200);
    const operation = response.body.paths['/cash-in'].post;
    const bodySchema = operation.requestBody.content['application/json'].schema;
    const idempotencyHeader = operation.parameters.find(
      (parameter: { name: string }) => parameter.name === 'Idempotency-Key',
    );

    assert.deepEqual(bodySchema.required.sort(), [
      'amount',
      'currency',
      'payment_method',
      'user_id',
    ]);
    assert.deepEqual(bodySchema.properties.currency.enum, ['PEN']);
    assert.equal(idempotencyHeader.required, true);
  });

  it('GET /docs/: sirve Swagger UI', async () => {
    const response = await request(app).get('/docs/').expect(200);

    assert.match(response.headers['content-type'], /html/);
    assert.match(response.text, /swagger-ui/i);
  });
});
