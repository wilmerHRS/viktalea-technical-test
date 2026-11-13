import { ValidationError } from '../../../../shared/domain/errors/app.errors.ts';

export const CENTS_PER_UNIT = 100;
const POSITIVE_AMOUNT_MESSAGE = 'Must be a positive finite number';
const WHOLE_CENTS_MESSAGE = 'Must represent whole cents precisely, with at most 2 decimals';

export const toCents = (amount: unknown): number => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Invalid amount', [
      { field: 'amount', message: POSITIVE_AMOUNT_MESSAGE },
    ]);
  }
  const scaled = amount * CENTS_PER_UNIT;
  const cents = Math.round(scaled);
  // Solo se tolera el ruido de coma flotante (p. ej. 0.1 + 0.2), nunca una fracción de céntimo.
  const representationNoise = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const tolerance = Math.min(1e-6, representationNoise);
  const isPositiveSafeInteger = Number.isSafeInteger(cents) && cents > 0;
  const hasFractionalCent = Math.abs(scaled - cents) > tolerance;
  if (!isPositiveSafeInteger || hasFractionalCent) {
    throw new ValidationError('Invalid amount', [
      { field: 'amount', message: WHOLE_CENTS_MESSAGE },
    ]);
  }
  return cents;
};

export const fromCents = (cents: number): number => cents / CENTS_PER_UNIT;
