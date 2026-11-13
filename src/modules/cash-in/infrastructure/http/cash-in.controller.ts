import type { Request, Response } from 'express';
import { InvalidIdempotencyKeyError } from '../../../../shared/domain/errors/app.errors.ts';
import { zodToValidationError } from '../../../../shared/infrastructure/http/zod-validation.util.ts';
import type { CreateCashIn } from '../../application/use-cases/create-cash-in.use-case.ts';
import { presentCashIn } from './cash-in.presenter.ts';
import { cashInBodySchema, idempotencyKeySchema } from './cash-in.validation.ts';

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const INVALID_BODY_MESSAGE = 'Invalid cash-in request';

interface CashInControllerDependencies {
  createCashIn: CreateCashIn;
}

/** POST /cash-in: valida la entrada, llama al caso de uso y traduce la respuesta. */
export class CashInController {
  private readonly createCashIn: CreateCashIn;

  constructor({ createCashIn }: CashInControllerDependencies) {
    this.createCashIn = createCashIn;
  }

  create = async (req: Request, res: Response): Promise<void> => {
    const idempotencyKey = this.readIdempotencyKey(req);
    const body = cashInBodySchema.safeParse(req.body);
    if (!body.success) {
      throw zodToValidationError(body.error, INVALID_BODY_MESSAGE);
    }

    const result = await this.createCashIn.execute({
      idempotencyKey,
      userId: body.data.user_id,
      amount: body.data.amount,
      currency: body.data.currency,
      paymentMethod: body.data.payment_method,
    });

    const response = presentCashIn(result);
    if (response.retryAfterSeconds !== null) {
      res.set('Retry-After', String(response.retryAfterSeconds));
    }
    res.status(response.status).json(response.body);
  };

  private readIdempotencyKey(req: Request): string {
    const header = idempotencyKeySchema.safeParse(req.get(IDEMPOTENCY_KEY_HEADER));
    if (!header.success) {
      throw new InvalidIdempotencyKeyError();
    }
    return header.data;
  }
}
