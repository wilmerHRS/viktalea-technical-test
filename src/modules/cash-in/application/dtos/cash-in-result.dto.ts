import type { Operation } from '../../domain/entities/operation.entity.ts';
import { fromCents } from '../../domain/value-objects/money.value-object.ts';
import {
  toApiStatus,
  type ApiOperationStatus,
} from '../../domain/value-objects/operation-status.value-object.ts';

/** Resultado de un cash-in tal como lo ve el cliente (montos en unidades, no en céntimos). */
export interface CashInResult {
  operationId: string;
  status: ApiOperationStatus;
  amount: number;
  /** Solo si se completó: el saldo justo después de acreditar ESTA operación (R1.5). */
  newBalance: number | null;
  /** Solo si falló: el motivo que dio la pasarela (R1.6). */
  failureReason: string | null;
}

export const toCashInResult = (operation: Operation): CashInResult => ({
  operationId: operation.id,
  status: toApiStatus(operation.status),
  amount: fromCents(operation.amountCents),
  newBalance: operation.newBalanceCents === null ? null : fromCents(operation.newBalanceCents),
  failureReason: operation.failureReason,
});
