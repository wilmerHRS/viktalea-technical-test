import type { DbExecutor } from '../../../../../shared/infrastructure/db/db.client.ts';
import type {
  LedgerRepository,
  NewLedgerEntry,
} from '../../../domain/repositories/ledger.repository.ts';
import { ledgerEntries } from '../tables/cash-in.tables.ts';

export class DrizzleLedgerRepository implements LedgerRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async append(entry: NewLedgerEntry): Promise<void> {
    // UNIQUE(operation_id) es la última red de seguridad: un segundo movimiento para la misma
    // operación falla y revierte toda la unidad de trabajo.
    await this.db.insert(ledgerEntries).values(entry);
  }
}
