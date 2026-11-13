import type { Request, Response } from 'express';
import { HttpStatus } from '../../../../shared/infrastructure/http/http-status.constants.ts';
import { InvalidSignatureError } from '../../../../shared/infrastructure/http/http.errors.ts';
import { zodToValidationError } from '../../../../shared/infrastructure/http/zod-validation.util.ts';
import type { HandlePaymentWebhook } from '../../application/use-cases/handle-payment-webhook.use-case.ts';
import { ChargeOutcome } from '../../domain/gateways/payment-provider.gateway.ts';
import type { PaymentWebhookEvent } from '../../domain/value-objects/payment-webhook-event.value-object.ts';
import { WebhookEventResult } from '../../domain/value-objects/webhook-event-result.value-object.ts';
import { paymentWebhookBodySchema } from './cash-in.validation.ts';
import { verifySignature } from './webhook-signature.util.ts';

const SIGNATURE_HEADER = 'X-Signature';
const INVALID_BODY_MESSAGE = 'Invalid payment webhook';

interface PaymentWebhookControllerDependencies {
  handlePaymentWebhook: HandlePaymentWebhook;
  webhookSecret: string;
}

/**
 * POST /webhooks/payment: verifica la firma, valida el body y aplica el evento.
 * Responde 200 a todo lo procesado (incluidos duplicados y conflictos) para que la pasarela
 * deje de reintentar; un 5xx hace que lo reintente (R5.7).
 */
export class PaymentWebhookController {
  private readonly handlePaymentWebhook: HandlePaymentWebhook;
  private readonly webhookSecret: string;

  constructor({ handlePaymentWebhook, webhookSecret }: PaymentWebhookControllerDependencies) {
    this.handlePaymentWebhook = handlePaymentWebhook;
    this.webhookSecret = webhookSecret;
  }

  receive = async (req: Request, res: Response): Promise<void> => {
    const signature = req.get(SIGNATURE_HEADER);
    if (!verifySignature(req.rawBody, signature, this.webhookSecret)) {
      throw new InvalidSignatureError();
    }

    const event = this.parseEvent(req.body);
    const handled = await this.handlePaymentWebhook.execute(event);

    if (handled.duplicate) {
      res.status(HttpStatus.OK).json({ received: true, duplicate: true });
      return;
    }
    if (handled.result === WebhookEventResult.CONFLICT) {
      // El evento contradice un estado final: no se cambia nada, pero alguien debe revisarlo
      // (R5.4).
      req.log.warn(
        {
          eventId: event.eventId,
          operationId: event.operationId,
          eventStatus: event.status,
          finalStatus: handled.operation.status,
        },
        'Payment webhook contradicts final operation status',
      );
    }
    res.status(HttpStatus.OK).json({ received: true, result: handled.result });
  };

  private parseEvent(body: unknown): PaymentWebhookEvent {
    const parsed = paymentWebhookBodySchema.safeParse(body);
    if (!parsed.success) {
      throw zodToValidationError(parsed.error, INVALID_BODY_MESSAGE);
    }
    const data = parsed.data;
    const common = { eventId: data.event_id, operationId: data.operation_id, payload: body };
    // Se separan las ramas para que TypeScript garantice que una aprobación trae providerChargeId.
    if (data.status === ChargeOutcome.APPROVED) {
      return { ...common, status: data.status, providerChargeId: data.provider_charge_id };
    }
    return { ...common, status: data.status, providerChargeId: data.provider_charge_id };
  }
}
