import { createApp } from './app.ts';
import { env } from './config/env.config.ts';
import { createCashInModule } from './modules/cash-in/cash-in.module.ts';
import { FakePaymentProvider } from './modules/cash-in/infrastructure/provider/fake-payment.provider.ts';
import { createDb } from './shared/infrastructure/db/db.client.ts';
import { logger } from './shared/infrastructure/logging/logger.config.ts';

const { db, pool } = createDb(env);

// Aquí se crean todos los módulos y se entregan a la app.
// Para añadir un módulo: créalo y agrégalo a esta lista.
const app = createApp([
  createCashInModule({
    db,
    // Pasarela simulada: el resultado depende de `payment_method` (ver FakePaymentMethod).
    paymentProvider: new FakePaymentProvider(),
    webhookSecret: env.WEBHOOK_SECRET,
    providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
    logger,
  }), // → POST /cash-in y POST /webhooks/payment
]);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Server listening');
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
