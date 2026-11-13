import { createHash } from 'node:crypto';

export interface HashableCashInRequest {
  userId: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
}

/**
 * Huella del payload de un cash-in. Se guarda con la operación para detectar que la misma
 * Idempotency-Key se reutiliza con otro payload (R2.4). El orden de los campos es fijo para que
 * el mismo payload produzca siempre el mismo hash.
 */
export const hashCashInRequest = (request: HashableCashInRequest): string => {
  const canonicalPayload = JSON.stringify([
    request.userId,
    request.amountCents,
    request.currency,
    request.paymentMethod,
  ]);
  return createHash('sha256').update(canonicalPayload).digest('hex');
};
