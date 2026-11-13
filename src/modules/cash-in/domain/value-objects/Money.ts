import { ValidationError } from '../../../../shared/domain/errors/index.ts';

export const CENTS_PER_UNIT = 100;

export const toCents = (amount: unknown): number => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Invalid amount', [{ field: 'amount', message: 'Must be a positive finite number' }]);
  }
  const scaled = amount * CENTS_PER_UNIT;
  const cents = Math.round(scaled);
  // Accept only floating-point representation noise (e.g. 0.1 + 0.2), never a fractional cent.
  const tolerance = Math.min(1e-6, Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4);
  if (!Number.isSafeInteger(cents) || cents <= 0 || Math.abs(scaled - cents) > tolerance) {
    throw new ValidationError('Invalid amount', [{ field: 'amount', message: 'Must represent whole cents precisely, with at most 2 decimals' }]);
  }
  return cents;
};

export const fromCents = (cents: number): number => cents / CENTS_PER_UNIT;
