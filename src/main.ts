import { createApp } from './app.ts';
import { env } from './config/env.config.ts';
import { createCashInModule, createCashInReconciler } from './modules/cash-in/cash-in.module.ts';
import { startReconcilerJob } from './modules/cash-in/infrastructure/jobs/reconciler.job.ts';
import { FakePaymentProvider } from './modules/cash-in/infrastructure/provider/fake-payment.provider.ts';
import { createDb } from './shared/infrastructure/db/db.client.ts';
import { logger } from './shared/infrastructure/logging/logger.config.ts';

const { db, pool } = createDb(env);

// Pasarela simulada: el resultado depende de `payment_method` (ver FakePaymentMethod).
// La comparten la API y el reconciliador, igual que compartirían la pasarela real.
const paymentProvider = new FakePaymentProvider();

// Aquí se crean todos los módulos y se entregan a la app.
// Para añadir un módulo: créalo y agrégalo a esta lista.
const app = createApp([
  createCashInModule({
    db,
    paymentProvider,
    webhookSecret: env.WEBHOOK_SECRET,
    providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
    logger,
  }), // → POST /cash-in y POST /webhooks/payment
]);

// Resuelve las operaciones UNKNOWN o atascadas: al arrancar y cada RECONCILE_INTERVAL_MS (R7).
const reconcilerJob = startReconcilerJob({
  reconcileOperations: createCashInReconciler({
    db,
    paymentProvider,
    providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
    staleAfterMs: env.RECONCILE_AFTER_MS,
    leaseMs: env.RECONCILE_LEASE_MS,
    logger,
  }),
  intervalMs: env.RECONCILE_INTERVAL_MS,
  logger,
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Server listening');
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'Shutting down');
  reconcilerJob.stop();
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
