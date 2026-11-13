import { z } from 'zod';
import { Currency } from '../../../domain/value-objects/currency.value-object.ts';

/** Header obligatorio de POST /cash-in (R1.2). */
export const idempotencyKeySchema = z.uuid();

/** Body de POST /cash-in (R1.3). Los decimales del monto los valida `toCents` en el dominio. */
export const cashInBodySchema = z.object({
  user_id: z.string().trim().min(1),
  amount: z.number().positive(),
  currency: z.enum(Currency),
  payment_method: z.string().trim().min(1),
});
