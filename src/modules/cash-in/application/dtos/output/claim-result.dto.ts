import type { Operation } from '../../../domain/entities/operation.entity.ts';

/** Resultado de registrar la operación de una idempotency key. */
export interface ClaimResult {
  /** true para la primera request con esta idempotency key; false para cualquier repetición. */
  created: boolean;
  operation: Operation;
}
