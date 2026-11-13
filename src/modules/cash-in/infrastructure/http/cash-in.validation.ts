import { z } from 'zod';
import { ChargeOutcome } from '../../domain/gateways/payment-provider.gateway.ts';
import { Currency } from '../../domain/value-objects/currency.value-object.ts';

/** Header obligatorio de POST /cash-in (R1.2). */
export const idempotencyKeySchema = z.uuid();

/** Body de POST /cash-in (R1.3). Los decimales del monto los valida `toCents` en el dominio. */
export const cashInBodySchema = z.object({
  user_id: z.string().trim().min(1),
  amount: z.number().positive(),
  currency: z.enum(Currency),
  payment_method: z.string().trim().min(1),
});

const webhookCommonFields = {
  event_id: z.string().trim().min(1),
  operation_id: z.string().trim().min(1),
  occurred_at: z.iso.datetime().optional(),
};

/**
 * Body de POST /webhooks/payment (R5.1). Una aprobación sin `provider_charge_id` se rechaza
 * aquí con 400, antes de tocar la base de datos.
 */
export const paymentWebhookBodySchema = z.discriminatedUnion('status', [
  z.object({
    ...webhookCommonFields,
    status: z.literal(ChargeOutcome.APPROVED),
    provider_charge_id: z.string().trim().min(1),
  }),
  z.object({
    ...webhookCommonFields,
    status: z.literal(ChargeOutcome.DECLINED),
    provider_charge_id: z.string().trim().min(1).optional(),
  }),
]);
