import { z } from 'zod';
import { ChargeOutcome } from '../../../domain/gateways/payment-provider.gateway.ts';

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
