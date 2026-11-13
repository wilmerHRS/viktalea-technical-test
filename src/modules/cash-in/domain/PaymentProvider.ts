export type ChargeResult =
  | { outcome: 'approved'; providerChargeId: string }
  | { outcome: 'declined'; reason: string };
export type ChargeStatus = 'approved' | 'declined' | 'pending' | 'not_found';

export interface PaymentProvider {
  /** idempotencyKey = operation.id. Never retry charge after an ambiguous result. */
  charge(req: { idempotencyKey: string; amountCents: number; currency: string; paymentMethod: string }): Promise<ChargeResult>;
  getChargeStatus(idempotencyKey: string): Promise<{ status: ChargeStatus; providerChargeId?: string; reason?: string }>;
}
