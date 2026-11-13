import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { DbExecutor } from '../../../../../shared/infrastructure/db/db.client.ts';
import {
  millisecondsAgo,
  millisecondsFromNow,
  NOW,
} from '../../../../../shared/infrastructure/db/utils/sql-time.util.ts';
import type { NewOperation, Operation } from '../../../domain/entities/operation.entity.ts';
import type {
  LeaseCriteria,
  OperationRepository,
  StatusChange,
} from '../../../domain/repositories/operation.repository.ts';
import { OperationStatus } from '../../../domain/value-objects/operation-status.value-object.ts';
import { toOperation } from '../mappers/operation.mapper.ts';
import { ledgerEntries, operations } from '../tables/cash-in.tables.ts';

export class DrizzleOperationRepository implements OperationRepository {
  private readonly db: DbExecutor;

  /** `db` es el cliente compartido o la transacción de la unidad de trabajo actual. */
  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertIfKeyIsNew(operation: NewOperation): Promise<Operation | null> {
    // ON CONFLICT DO NOTHING: si otra request (de cualquier pod) tiene la key, este INSERT
    // espera a que confirme y luego no inserta nada.
    const [inserted] = await this.db
      .insert(operations)
      .values({ ...operation, status: OperationStatus.PROCESSING })
      .onConflictDoNothing({ target: operations.idempotencyKey })
      .returning();
    return inserted ? toOperation(inserted) : null;
  }

  async findById(id: string): Promise<Operation | null> {
    const [found] = await this.selectWithBalance().where(eq(operations.id, id));
    return found ? toOperation(found.operation, found.balanceAfterCents) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Operation | null> {
    const isSameKey = eq(operations.idempotencyKey, idempotencyKey);
    const [found] = await this.selectWithBalance().where(isSameKey);
    return found ? toOperation(found.operation, found.balanceAfterCents) : null;
  }

  async changeStatus(id: string, change: StatusChange): Promise<Operation | null> {
    const isThisOperation = eq(operations.id, id);
    const isInAllowedStatus = inArray(operations.status, change.from);

    // El WHERE vuelve a comprobar el estado después de tomar el lock de la fila: si dos
    // procesos compiten, el segundo encuentra el estado nuevo y no actualiza nada.
    const [changed] = await this.db
      .update(operations)
      .set({
        status: change.to,
        providerChargeId: change.providerChargeId,
        failureReason: change.failureReason,
        updatedAt: NOW,
      })
      .where(and(isThisOperation, isInAllowedStatus))
      .returning();
    return changed ? toOperation(changed) : null;
  }

  async leasePendingBatch(criteria: LeaseCriteria): Promise<Operation[]> {
    const isUnknown = eq(operations.status, OperationStatus.UNKNOWN);
    const isProcessing = eq(operations.status, OperationStatus.PROCESSING);
    const isStale = lt(operations.updatedAt, millisecondsAgo(criteria.staleAfterMs));
    const needsReconciling = or(isUnknown, and(isProcessing, isStale));

    const hasNoLease = isNull(operations.reconcileLockedUntil);
    const hasExpiredLease = lt(operations.reconcileLockedUntil, NOW);
    const isLeaseFree = or(hasNoLease, hasExpiredLease);

    // SKIP LOCKED: las filas que otro pod está reservando ahora se saltan, no se esperan.
    const candidateIds = this.db
      .select({ id: operations.id })
      .from(operations)
      .where(and(needsReconciling, isLeaseFree))
      .orderBy(operations.updatedAt)
      .limit(criteria.limit)
      .for('update', { skipLocked: true });

    // Solo cambia la columna del lease: updated_at sigue midiendo cuánto lleva atascada.
    const reserved = await this.db
      .update(operations)
      .set({ reconcileLockedUntil: millisecondsFromNow(criteria.leaseMs) })
      .where(inArray(operations.id, candidateIds))
      .returning();
    return reserved.map((row) => toOperation(row));
  }

  /** La operación más el saldo que quedó en el ledger cuando se acreditó (si se acreditó). */
  private selectWithBalance() {
    return this.db
      .select({ operation: operations, balanceAfterCents: ledgerEntries.balanceAfterCents })
      .from(operations)
      .leftJoin(ledgerEntries, eq(ledgerEntries.operationId, operations.id));
  }
}
