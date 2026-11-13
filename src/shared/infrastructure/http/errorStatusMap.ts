import { ErrorCode } from '../../domain/errors/index.ts';
import { HttpStatus } from './httpStatus.ts';

export const HttpErrorCode = { INVALID_JSON: 'INVALID_JSON', ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND' } as const;
export type HttpErrorCode = typeof HttpErrorCode[keyof typeof HttpErrorCode];

export const errorStatusMap: Readonly<Record<string, HttpStatus>> = {
  [ErrorCode.VALIDATION_ERROR]: HttpStatus.BAD_REQUEST,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [HttpErrorCode.INVALID_JSON]: HttpStatus.BAD_REQUEST,
  [HttpErrorCode.ROUTE_NOT_FOUND]: HttpStatus.NOT_FOUND,
};
