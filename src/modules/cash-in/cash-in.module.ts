// Composition root del módulo cash-in: crea los adaptadores, los casos de uso y los controllers.
import type { Logger } from 'pino';
import type { Db } from '../../shared/infrastructure/db/db.client.ts';
import type { HttpModule } from '../../shared/infrastructure/http/http-module.interface.ts';
import { ClaimOperation } from './application/use-cases/claim-operation.use-case.ts';
import { CreateCashIn } from './application/use-cases/create-cash-in.use-case.ts';
import { HandlePaymentWebhook } from './application/use-cases/handle-payment-webhook.use-case.ts';
import { MarkOperationUnknown } from './application/use-cases/mark-operation-unknown.use-case.ts';
import { ReconcileOperations } from './application/use-cases/reconcile-operations.use-case.ts';
import { SettleOperation } from './application/use-cases/settle-operation.use-case.ts';
import type { PaymentProvider } from './domain/gateways/payment-provider.gateway.ts';
import { CashInController } from './infrastructure/http/cash-in.controller.ts';
import { buildCashInRouter } from './infrastructure/http/cash-in.routes.ts';
import { PaymentWebhookController } from './infrastructure/http/payment-webhook.controller.ts';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work.ts';

const ROOT_PATH = '/';

export interface CashInModuleDependencies {
  db: Db;
  paymentProvider: PaymentProvider;
  webhookSecret: string;
  providerTimeoutMs: number;
  logger: Logger;
}

export const createCashInModule = (dependencies: CashInModuleDependencies): HttpModule => {
  const unitOfWork = new DrizzleUnitOfWork(dependencies.db);
  const settleOperation = new SettleOperation({ unitOfWork });

  const createCashIn = new CreateCashIn({
    unitOfWork,
    claimOperation: new ClaimOperation({ unitOfWork }),
    settleOperation,
    markOperationUnknown: new MarkOperationUnknown({ unitOfWork }),
    paymentProvider: dependencies.paymentProvider,
    providerTimeoutMs: dependencies.providerTimeoutMs,
    logger: dependencies.logger,
  });

  const router = buildCashInRouter({
    cashIn: new CashInController({ createCashIn }),
    paymentWebhook: new PaymentWebhookController({
      handlePaymentWebhook: new HandlePaymentWebhook({ unitOfWork }),
      webhookSecret: dependencies.webhookSecret,
    }),
  });

  return { basePath: ROOT_PATH, router };
};

export interface CashInReconcilerDependencies {
  db: Db;
  paymentProvider: PaymentProvider;
  providerTimeoutMs: number;
  staleAfterMs: number;
  leaseMs: number;
  logger: Logger;
}

/** Caso de uso del reconciliador (R7). Lo ejecuta periódicamente `startReconcilerJob`. */
export const createCashInReconciler = (
  dependencies: CashInReconcilerDependencies,
): ReconcileOperations => {
  const unitOfWork = new DrizzleUnitOfWork(dependencies.db);
  return new ReconcileOperations({
    unitOfWork,
    settleOperation: new SettleOperation({ unitOfWork }),
    paymentProvider: dependencies.paymentProvider,
    settings: {
      staleAfterMs: dependencies.staleAfterMs,
      leaseMs: dependencies.leaseMs,
      providerTimeoutMs: dependencies.providerTimeoutMs,
    },
    logger: dependencies.logger,
  });
};
