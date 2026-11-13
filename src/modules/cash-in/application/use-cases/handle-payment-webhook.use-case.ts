import type { Operation } from '../../domain/entities/operation.entity.ts';
import {
  toSettleOutcome,
  type PaymentWebhookEvent,
} from '../../domain/value-objects/payment-webhook-event.value-object.ts';
import {
  classifyWebhookResult,
  type WebhookEventResult,
} from '../../domain/value-objects/webhook-event-result.value-object.ts';
import type { UnitOfWork } from '../ports/unit-of-work.port.ts';
import { settleOperation } from '../services/settle-operation.service.ts';

interface DuplicateWebhook {
  duplicate: true;
}

interface ProcessedWebhook {
  duplicate: false;
  result: WebhookEventResult;
  operation: Operation;
}

export type HandlePaymentWebhookResult = DuplicateWebhook | ProcessedWebhook;

interface HandlePaymentWebhookDependencies {
  unitOfWork: UnitOfWork;
}

/**
 * Aplica a su operación un webhook de pago (con firma verificada y body validado) (R5).
 *
 * Todos los pasos van en UNA transacción: si algo falla, no se guarda ni el evento ni su efecto,
 * y la pasarela puede reintentar el webhook sin riesgo (R5.7).
 */
export class HandlePaymentWebhook {
  private readonly unitOfWork: UnitOfWork;

  constructor({ unitOfWork }: HandlePaymentWebhookDependencies) {
    this.unitOfWork = unitOfWork;
  }

  async execute(event: PaymentWebhookEvent): Promise<HandlePaymentWebhookResult> {
    return this.unitOfWork.run(async (repositories) => {
      // 1. Duplicados: gana la primera entrega de un eventId; las demás no hacen nada (R5.3).
      const isFirstDelivery = await repositories.webhookEvents.insertIfNew(event);
      if (!isFirstDelivery) {
        return { duplicate: true };
      }

      // 2. Finalizar la operación. Si ya era final (evento tardío o fuera de orden), el estado
      //    NO cambia (R5.4).
      const outcome = toSettleOutcome(event);
      const settlement = await settleOperation(repositories, event.operationId, outcome);

      // 3. Registrar qué hizo el evento: aplicado, ignorado (coincide) o conflicto (contradice).
      const result = classifyWebhookResult({
        applied: settlement.applied,
        eventStatus: event.status,
        finalStatus: settlement.operation.status,
      });
      await repositories.webhookEvents.saveResult(event.eventId, result);

      return { duplicate: false, result, operation: settlement.operation };
    });
  }
}
