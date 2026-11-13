// Composition root del módulo cash-in: crea los adaptadores, los casos de uso y los controllers.
import type { Logger } from 'pino';
import type { Db } from '../../shared/infrastructure/db/client.ts';
import type { HttpModule } from '../../shared/infrastructure/http/HttpModule.ts';
import { ClaimOperation } from './application/use-cases/ClaimOperation.ts';
import { CreateCashIn } from './application/use-cases/CreateCashIn.ts';
import { HandlePaymentWebhook } from './application/use-cases/HandlePaymentWebhook.ts';
import { MarkOperationUnknown } from './application/use-cases/MarkOperationUnknown.ts';
import { SettleOperation } from './application/use-cases/SettleOperation.ts';
import type { PaymentProvider } from './domain/gateways/PaymentProvider.ts';
import { CashInController } from './infrastructure/http/CashInController.ts';
import { buildCashInRouter } from './infrastructure/http/cashInRoutes.ts';
import { PaymentWebhookController } from './infrastructure/http/PaymentWebhookController.ts';
import { DrizzleUnitOfWork } from './infrastructure/persistence/DrizzleUnitOfWork.ts';

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
