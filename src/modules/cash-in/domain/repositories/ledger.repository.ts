export interface NewLedgerEntry {
  operationId: string;
  userId: string;
  amountCents: number;
  /**
   * Saldo justo después de este abono: permite que un replay devuelva el mismo `new_balance`
   * (R2.2).
   */
  balanceAfterCents: number;
}

/** Registro inmutable de movimientos de saldo: como máximo un movimiento por operación (R6.2). */
export interface LedgerRepository {
  append(entry: NewLedgerEntry): Promise<void>;
}
