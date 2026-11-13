import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ChargeOutcome,
  DEFAULT_DECLINE_REASON,
  ProviderChargeStatus,
  type ChargeRequest,
  type ChargeResult,
  type ChargeStatusResult,
  type PaymentProvider,
} from '../../domain/gateways/PaymentProvider.ts';
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../domain/gateways/PaymentProviderErrors.ts';

/** Cómo responde la pasarela simulada a un cobro. */
export const FakeChargeBehavior = {
  APPROVE: 'approve',
  DECLINE: 'decline',
  /** No cobra y no responde a tiempo. */
  TIMEOUT: 'timeout',
  /** Cobra, pero la respuesta se pierde: el caso de la pregunta central del challenge. */
  TIMEOUT_AFTER_CHARGE: 'timeout_after_charge',
  /** No cobra y responde con error de red / 5xx. */
  UNAVAILABLE: 'unavailable',
} as const;
export type FakeChargeBehavior = (typeof FakeChargeBehavior)[keyof typeof FakeChargeBehavior];

/** `payment_method` que eligen un comportamiento al probar a mano (npm run dev). */
export const FakePaymentMethod = {
  DECLINED: 'card_declined',
  TIMEOUT: 'card_timeout',
  TIMEOUT_AFTER_CHARGE: 'card_timeout_after_charge',
  UNAVAILABLE: 'card_unavailable',
} as const;

const BEHAVIOR_BY_PAYMENT_METHOD: Readonly<Record<string, FakeChargeBehavior>> = {
  [FakePaymentMethod.DECLINED]: FakeChargeBehavior.DECLINE,
  [FakePaymentMethod.TIMEOUT]: FakeChargeBehavior.TIMEOUT,
  [FakePaymentMethod.TIMEOUT_AFTER_CHARGE]: FakeChargeBehavior.TIMEOUT_AFTER_CHARGE,
  [FakePaymentMethod.UNAVAILABLE]: FakeChargeBehavior.UNAVAILABLE,
};

const CHARGE_ID_PREFIX = 'ch_';

/**
 * Pasarela de pagos simulada, en memoria. Representa al sistema EXTERNO: la idempotencia del
 * servicio NO depende de ella. Igual que una pasarela real, es idempotente por `idempotencyKey`:
 * repetir un cobro con la misma key devuelve el resultado del primero sin cobrar de nuevo.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly charges = new Map<string, ChargeResult>();
  private readonly callsByKey = new Map<string, number>();
  private delayMs = 0;

  /** Retraso antes de responder a `charge` (para simular que el webhook llega antes). */
  setDelay(delayMs: number): void {
    this.delayMs = delayMs;
  }

  /** Cuántas veces se llamó a `charge` con esta key. */
  chargeCalls(idempotencyKey: string): number {
    return this.callsByKey.get(idempotencyKey) ?? 0;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const { idempotencyKey } = request;
    this.callsByKey.set(idempotencyKey, this.chargeCalls(idempotencyKey) + 1);
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    const previousCharge = this.charges.get(idempotencyKey);
    if (previousCharge) {
      return previousCharge;
    }

    const behavior =
      BEHAVIOR_BY_PAYMENT_METHOD[request.paymentMethod] ?? FakeChargeBehavior.APPROVE;
    switch (behavior) {
      case FakeChargeBehavior.DECLINE:
        return this.record(idempotencyKey, {
          outcome: ChargeOutcome.DECLINED,
          reason: DEFAULT_DECLINE_REASON,
        });
      case FakeChargeBehavior.TIMEOUT:
        throw new ProviderTimeoutError();
      case FakeChargeBehavior.TIMEOUT_AFTER_CHARGE:
        this.record(idempotencyKey, this.approvedCharge());
        throw new ProviderTimeoutError();
      case FakeChargeBehavior.UNAVAILABLE:
        throw new ProviderUnavailableError();
      default:
        return this.record(idempotencyKey, this.approvedCharge());
    }
  }

  async getChargeStatus(idempotencyKey: string): Promise<ChargeStatusResult> {
    const charge = this.charges.get(idempotencyKey);
    if (!charge) {
      return { status: ProviderChargeStatus.NOT_FOUND };
    }
    if (charge.outcome === ChargeOutcome.APPROVED) {
      return { status: ProviderChargeStatus.APPROVED, providerChargeId: charge.providerChargeId };
    }
    return { status: ProviderChargeStatus.DECLINED, reason: charge.reason };
  }

  private approvedCharge(): ChargeResult {
    return {
      outcome: ChargeOutcome.APPROVED,
      providerChargeId: `${CHARGE_ID_PREFIX}${randomUUID()}`,
    };
  }

  private record(idempotencyKey: string, result: ChargeResult): ChargeResult {
    this.charges.set(idempotencyKey, result);
    return result;
  }
}
