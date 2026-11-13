import type { StatusChange } from '../repositories/operation.repository.ts';
import { OperationStatus, SETTLEABLE_STATUSES } from './operation-status.value-object.ts';

/** Resultado con el que se liquida una operación: cobrada (con su ID) o rechazada (con motivo). */
export type SettleOutcome =
  | { status: typeof OperationStatus.COMPLETED; providerChargeId: string }
  | { status: typeof OperationStatus.FAILED; reason: string };

/** Cambio de estado que corresponde a liquidar: solo desde un estado liquidable (R3.2). */
export const toStatusChange = (outcome: SettleOutcome): StatusChange => {
  if (outcome.status === OperationStatus.COMPLETED) {
    return {
      from: SETTLEABLE_STATUSES,
      to: OperationStatus.COMPLETED,
      providerChargeId: outcome.providerChargeId,
    };
  }
  return {
    from: SETTLEABLE_STATUSES,
    to: OperationStatus.FAILED,
    failureReason: outcome.reason,
  };
};
