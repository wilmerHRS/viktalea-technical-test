import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * true si `signature` es el HMAC-SHA256 (hex) de `rawBody` con `secret` (R5.2).
 * Compara en tiempo constante para no filtrar información por el tiempo de respuesta.
 */
export const verifySignature = (
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (!rawBody || !signature) {
    return false;
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

/** Calcula la firma de un body (la usan los tests y quien quiera simular la pasarela). */
export const signPayload = (rawBody: string, secret: string): string =>
  createHmac('sha256', secret).update(rawBody).digest('hex');
