import type { Db, DbExecutor } from '../../../../../shared/infrastructure/db/db.client.ts';
import type {
  CashInRepositories,
  UnitOfWork,
} from '../../../application/ports/unit-of-work.port.ts';
import { DrizzleLedgerRepository } from '../repositories/drizzle-ledger.repository.ts';
import { DrizzleOperationRepository } from '../repositories/drizzle-operation.repository.ts';
import { DrizzleWalletRepository } from '../repositories/drizzle-wallet.repository.ts';
import { DrizzleWebhookEventRepository } from '../repositories/drizzle-webhook-event.repository.ts';

/** Construye todos los repositorios sobre el mismo ejecutor, para que compartan la transacción. */
export const createCashInRepositories = (db: DbExecutor): CashInRepositories => ({
  operations: new DrizzleOperationRepository(db),
  wallets: new DrizzleWalletRepository(db),
  ledger: new DrizzleLedgerRepository(db),
  webhookEvents: new DrizzleWebhookEventRepository(db),
});

/**
 * Unidad de trabajo sobre una transacción de PostgreSQL (commit si todo va bien, rollback si
 * falla).
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async run<T>(work: (repositories: CashInRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(createCashInRepositories(tx)));
  }
}
