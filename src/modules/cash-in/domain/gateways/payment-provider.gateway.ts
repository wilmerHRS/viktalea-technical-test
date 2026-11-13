import type { Currency } from '../value-objects/currency.value-object.ts';

export const ChargeOutcome = { APPROVED: 'approved', DECLINED: 'declined' } as const;
export type ChargeOutcome = (typeof ChargeOutcome)[keyof typeof ChargeOutcome];
export const ProviderChargeStatus = {
  APPROVED: 'approved',
  DECLINED: 'declined',
  PENDING: 'pending',
  NOT_FOUND: 'not_found',
} as const;
export type ProviderChargeStatus = (typeof ProviderChargeStatus)[keyof typeof ProviderChargeStatus];
export const DEFAULT_DECLINE_REASON = 'Payment declined';

export type ChargeResult =
  | { outcome: typeof ChargeOutcome.APPROVED; providerChargeId: string }
  | { outcome: typeof ChargeOutcome.DECLINED; reason: string };

export interface ChargeRequest {
  idempotencyKey: string;
  amountCents: number;
  currency: Currency;
  paymentMethod: string;
}

export interface ChargeStatusResult {
  status: ProviderChargeStatus;
  providerChargeId?: string;
  reason?: string;
}

export interface PaymentProvider {
  /** idempotencyKey = operation.id. Nunca reintentar el cobro tras un resultado incierto. */
  charge(req: ChargeRequest): Promise<ChargeResult>;
  getChargeStatus(idempotencyKey: string): Promise<ChargeStatusResult>;
}
