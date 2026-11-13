import type { ErrorRequestHandler } from 'express';
import { AppError, ErrorCode } from '../../../domain/errors/app.errors.ts';
import { isDatabaseUnavailableError } from '../../db/database-unavailable.util.ts';
import { errorStatusMap, HttpErrorCode } from '../error-status.map.ts';
import { HttpStatus } from '../http-status.constants.ts';
import { isJsonParseError } from '../json-parse-error.util.ts';

const MALFORMED_JSON_MESSAGE = 'Malformed JSON body';
const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable, retry with the same key';
const INTERNAL_ERROR_MESSAGE = 'Internal server error';
const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = '5';

/**
 * Convierte cualquier error en una respuesta `{ error: { code, message } }`.
 * Nunca expone stack traces ni detalles internos (R8.3).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Express reconoce un manejador de errores porque recibe cuatro argumentos.
  void _next;

  if (err instanceof AppError) {
    const status = errorStatusMap[err.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    res.status(status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // El cliente envió un body JSON mal formado.
  if (isJsonParseError(err)) {
    res
      .status(HttpStatus.BAD_REQUEST)
      .json({ error: { code: HttpErrorCode.INVALID_JSON, message: MALFORMED_JSON_MESSAGE } });
    return;
  }

  // La BD no está disponible: el cliente puede reintentar con la misma key sin riesgo (R8.1).
  if (isDatabaseUnavailableError(err)) {
    req.log.warn({ err }, 'Database unavailable');
    res
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .set('Retry-After', SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS)
      .json({
        error: { code: HttpErrorCode.SERVICE_UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE },
      });
    return;
  }

  req.log.error({ err }, 'Request failed');
  res
    .status(HttpStatus.INTERNAL_SERVER_ERROR)
    .json({ error: { code: ErrorCode.INTERNAL_ERROR, message: INTERNAL_ERROR_MESSAGE } });
};
