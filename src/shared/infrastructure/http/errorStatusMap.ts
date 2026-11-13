import { ErrorCode } from '../../domain/errors/index.ts';
import { HttpStatus } from './httpStatus.ts';

/** Códigos de error que solo existen en la capa HTTP (no son errores de dominio). */
export const HttpErrorCode = {
  INVALID_JSON: 'INVALID_JSON',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;
export type HttpErrorCode = (typeof HttpErrorCode)[keyof typeof HttpErrorCode];

/** Traduce el código de un error (de dominio o HTTP) a su código de estado HTTP. */
export const errorStatusMap: Readonly<Record<string, HttpStatus>> = {
  [ErrorCode.VALIDATION_ERROR]: HttpStatus.BAD_REQUEST,
  [ErrorCode.INVALID_IDEMPOTENCY_KEY]: HttpStatus.BAD_REQUEST,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [HttpErrorCode.INVALID_JSON]: HttpStatus.BAD_REQUEST,
  [HttpErrorCode.ROUTE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [HttpErrorCode.INVALID_SIGNATURE]: HttpStatus.UNAUTHORIZED,
  [HttpErrorCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
};
