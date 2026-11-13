import { ChargeOutcome, DEFAULT_DECLINE_REASON } from '../gateways/payment-provider.gateway.ts';
import { OperationStatus } from './operation-status.value-object.ts';
import type { SettleOutcome } from './settle-outcome.value-object.ts';

interface WebhookEventData {
  eventId: string;
  operationId: string;
  payload: unknown;
}

interface ApprovedWebhookEvent extends WebhookEventData {
  status: typeof ChargeOutcome.APPROVED;
  providerChargeId: string;
}

interface DeclinedWebhookEvent extends WebhookEventData {
  status: typeof ChargeOutcome.DECLINED;
  providerChargeId?: string;
}

/** Entrada ya validada por la capa HTTP: una aprobación siempre trae providerChargeId. */
export type PaymentWebhookEvent = ApprovedWebhookEvent | DeclinedWebhookEvent;

export const toSettleOutcome = (event: PaymentWebhookEvent): SettleOutcome => {
  if (event.status === ChargeOutcome.APPROVED) {
    return { status: OperationStatus.COMPLETED, providerChargeId: event.providerChargeId };
  }
  return { status: OperationStatus.FAILED, reason: DEFAULT_DECLINE_REASON };
};
