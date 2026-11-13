import type { PaymentWebhookEvent } from '../value-objects/payment-webhook-event.value-object.ts';
import type { WebhookEventResult } from '../value-objects/webhook-event-result.value-object.ts';

/** Registro de los webhooks de pago recibidos, para descartar duplicados (R5.3). */
export interface WebhookEventRepository {
  /** Inserta el evento salvo que su eventId ya se haya recibido. Devuelve false si es duplicado. */
  insertIfNew(event: PaymentWebhookEvent): Promise<boolean>;

  saveResult(eventId: string, result: WebhookEventResult): Promise<void>;
}
