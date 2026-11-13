/** Persistencia de las wallets de los usuarios (el saldo se guarda en céntimos). */
export interface WalletRepository {
  /** Crea la wallet con saldo 0 si el usuario todavía no tiene una (R1.4). */
  ensureExists(userId: string): Promise<void>;

  /** Suma `amountCents` de forma atómica (balance = balance + x) y devuelve el saldo nuevo. */
  credit(userId: string, amountCents: number): Promise<number>;
}
