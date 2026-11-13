import { ChargeOutcome } from '../gateways/PaymentProvider.ts';
import { OperationStatus } from './OperationStatus.ts';

export const WebhookEventResult = {
  APPLIED: 'applied',
  IGNORED: 'ignored',
  CONFLICT: 'conflict',
} as const;
export type WebhookEventResult = (typeof WebhookEventResult)[keyof typeof WebhookEventResult];

export interface WebhookClassification {
  applied: boolean;
  eventStatus: ChargeOutcome;
  finalStatus: OperationStatus;
}

export const classifyWebhookResult = ({
  applied,
  eventStatus,
  finalStatus,
}: WebhookClassification): WebhookEventResult => {
  if (applied) {
    return WebhookEventResult.APPLIED;
  }
  const expectedStatus =
    eventStatus === ChargeOutcome.APPROVED ? OperationStatus.COMPLETED : OperationStatus.FAILED;
  return finalStatus === expectedStatus ? WebhookEventResult.IGNORED : WebhookEventResult.CONFLICT;
};
