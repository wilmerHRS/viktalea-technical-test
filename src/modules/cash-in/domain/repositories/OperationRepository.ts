import type { NewOperation, Operation } from '../entities/Operation.ts';
import type { OperationStatus } from '../value-objects/OperationStatus.ts';

/** Cambio de estado que solo se aplica si la operación está en uno de los estados `from`. */
export interface StatusChange {
  from: readonly OperationStatus[];
  to: OperationStatus;
  providerChargeId?: string | null;
  failureReason?: string | null;
}

/** Qué operaciones puede reservar el reconciliador, y por cuánto tiempo. */
export interface LeaseCriteria {
  /** Una operación en PROCESSING sin cambios durante más de esto se considera atascada. */
  staleAfterMs: number;
  /** Cuánto dura la reserva antes de que otro pod pueda tomar la operación. */
  leaseMs: number;
  limit: number;
}

/**
 * Persistencia de las operaciones de cash-in. Cada método es UNA sentencia atómica:
 * decidir qué hacer con una operación es trabajo de los casos de uso.
 */
export interface OperationRepository {
  /** Inserta la operación salvo que su idempotency key ya exista. Devuelve null si ya existía. */
  insertIfKeyIsNew(operation: NewOperation): Promise<Operation | null>;

  findById(id: string): Promise<Operation | null>;

  findByIdempotencyKey(idempotencyKey: string): Promise<Operation | null>;

  /**
   * Actualización condicional. Devuelve null si el estado actual no está en `change.from`,
   * es decir, si otro proceso ya movió la operación.
   */
  changeStatus(id: string, change: StatusChange): Promise<Operation | null>;

  /** Reserva operaciones pendientes para el reconciliador (UPDATE … FOR UPDATE SKIP LOCKED). */
  leasePendingBatch(criteria: LeaseCriteria): Promise<Operation[]>;
}
