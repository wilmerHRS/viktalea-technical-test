import { AppError } from '../../domain/errors/index.ts';
import { HttpErrorCode } from './errorStatusMap.ts';

/** La firma del webhook falta o no coincide (R5.2). Se responde 401 sin procesar nada. */
export class InvalidSignatureError extends AppError {
  constructor(message = 'Invalid or missing webhook signature') {
    super(message, { code: HttpErrorCode.INVALID_SIGNATURE });
  }
}
