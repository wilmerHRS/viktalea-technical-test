import type { Currency } from '../../../domain/value-objects/currency.value-object.ts';

/** Entrada de POST /cash-in, ya validada por la capa HTTP. */
export interface CreateCashInInput {
  idempotencyKey: string;
  userId: string;
  amount: number;
  currency: Currency;
  paymentMethod: string;
}
