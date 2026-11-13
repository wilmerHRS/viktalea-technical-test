import type { Operation } from '../../../domain/entities/operation.entity.ts';
import type { WebhookEventResult } from '../../../domain/value-objects/webhook-event-result.value-object.ts';

/** El eventId ya se había recibido: no se hizo nada (R5.3). */
export interface DuplicateWebhookResult {
  duplicate: true;
}

/** Primera entrega del evento: qué efecto tuvo sobre la operación. */
export interface ProcessedWebhookResult {
  duplicate: false;
  result: WebhookEventResult;
  operation: Operation;
}

export type PaymentWebhookResult = DuplicateWebhookResult | ProcessedWebhookResult;
