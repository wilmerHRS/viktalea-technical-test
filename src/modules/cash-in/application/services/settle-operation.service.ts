import { NotFoundError } from '../../../../shared/domain/errors/app.errors.ts';
import type { Operation } from '../../domain/entities/operation.entity.ts';
import { OperationStatus } from '../../domain/value-objects/operation-status.value-object.ts';
import {
  toStatusChange,
  type SettleOutcome,
} from '../../domain/value-objects/settle-outcome.value-object.ts';
import type { CashInRepositories } from '../ports/unit-of-work.port.ts';

export interface SettleResult {
  /** false si otra vía (respuesta de la API, webhook o reconciliador) ya la había finalizado. */
  applied: boolean;
  operation: Operation;
}

/**
 * Lleva una operación a su estado final y, si se completó, acredita la wallet (R3, R6).
 *
 * Es la ÚNICA forma de finalizar una operación: la usan la respuesta de la pasarela, el webhook
 * y el reconciliador. Debe ejecutarse dentro de una unidad de trabajo para que sus pasos se
 * confirmen juntos.
 */
export const settleOperation = async (
  repositories: CashInRepositories,
  operationId: string,
  outcome: SettleOutcome,
): Promise<SettleResult> => {
  const { operations, wallets, ledger } = repositories;

  // 1. Finalizar, pero solo si nadie lo hizo antes: la actualización depende del estado actual,
  //    así que dos vías concurrentes no pueden tener éxito a la vez (R3.4).
  const finalized = await operations.changeStatus(operationId, toStatusChange(outcome));

  if (!finalized) {
    const existing = await operations.findById(operationId);
    if (!existing) {
      throw new NotFoundError(`Cash-in operation ${operationId} not found`);
    }
    return { applied: false, operation: existing };
  }

  // 2. Un pago rechazado nunca toca el saldo (R1.6).
  if (finalized.status === OperationStatus.FAILED) {
    return { applied: true, operation: finalized };
  }

  // 3. Acreditar con un incremento atómico (R6.3) y registrar el movimiento (R6.2).
  const newBalanceCents = await wallets.credit(finalized.userId, finalized.amountCents);
  await ledger.append({
    operationId: finalized.id,
    userId: finalized.userId,
    amountCents: finalized.amountCents,
    balanceAfterCents: newBalanceCents,
  });

  return { applied: true, operation: finalized.withNewBalance(newBalanceCents) };
};
