import type { ApiOperationStatus } from '../../../domain/value-objects/operation-status.value-object.ts';

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
