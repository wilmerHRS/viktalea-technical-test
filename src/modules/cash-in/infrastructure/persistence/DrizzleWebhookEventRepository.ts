import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../../shared/infrastructure/db/client.ts';
import type { WebhookEventRepository } from '../../domain/repositories/WebhookEventRepository.ts';
import type { PaymentWebhookEvent } from '../../domain/value-objects/PaymentWebhookEvent.ts';
import type { WebhookEventResult } from '../../domain/value-objects/WebhookEventResult.ts';
import { webhookEvents } from './schema.ts';

export class DrizzleWebhookEventRepository implements WebhookEventRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertIfNew(event: PaymentWebhookEvent): Promise<boolean> {
    // `result` queda en NULL hasta que saveResult lo completa en la misma transacción, así que
    // una fila confirmada siempre lo tiene. Una entrega concurrente del mismo eventId espera aquí
    // y no inserta nada.
    const inserted = await this.db
      .insert(webhookEvents)
      .values({
        eventId: event.eventId,
        operationId: event.operationId,
        status: event.status,
        payload: event.payload,
      })
      .onConflictDoNothing({ target: webhookEvents.eventId })
      .returning({ eventId: webhookEvents.eventId });
    return inserted.length > 0;
  }

  async saveResult(eventId: string, result: WebhookEventResult): Promise<void> {
    await this.db.update(webhookEvents).set({ result }).where(eq(webhookEvents.eventId, eventId));
  }
}
