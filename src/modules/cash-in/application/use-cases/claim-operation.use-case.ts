import type { NewOperation, Operation } from '../../domain/entities/operation.entity.ts';
import type { UnitOfWork } from '../ports/unit-of-work.port.ts';

export interface ClaimResult {
  /** true para la primera request con esta idempotency key; false para cualquier repetición. */
  created: boolean;
  operation: Operation;
}

interface ClaimOperationDependencies {
  unitOfWork: UnitOfWork;
}

/**
 * Registra la operación de una idempotency key, o devuelve la que ya estaba registrada.
 *
 * Exactamente una request por key obtiene `created: true`, aunque lleguen a pods distintos:
 * quien gana lo decide la restricción UNIQUE de la base de datos, no la memoria (R2.1, R2.5).
 * La operación se confirma ANTES de llamar a la pasarela, así que una caída o un webhook
 * temprano siempre la encuentran (R8.2, R5.5).
 */
export class ClaimOperation {
  private readonly unitOfWork: UnitOfWork;

  constructor({ unitOfWork }: ClaimOperationDependencies) {
    this.unitOfWork = unitOfWork;
  }

  async execute(newOperation: NewOperation): Promise<ClaimResult> {
    return this.unitOfWork.run(async ({ operations, wallets }) => {
      await wallets.ensureExists(newOperation.userId);

      const created = await operations.insertIfKeyIsNew(newOperation);
      if (created) {
        return { created: true, operation: created };
      }

      // La key ya estaba tomada. El INSERT esperó a que la otra transacción confirmara,
      // así que su operación ya es visible.
      const existing = await operations.findByIdempotencyKey(newOperation.idempotencyKey);
      if (!existing) {
        throw new Error(`Idempotency key ${newOperation.idempotencyKey} taken but not readable`);
      }
      return { created: false, operation: existing };
    });
  }
}
