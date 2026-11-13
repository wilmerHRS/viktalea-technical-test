import type { ErrorRequestHandler } from 'express';
import { AppError, ErrorCode } from '../../../domain/errors/index.ts';
import { errorStatusMap, HttpErrorCode } from '../errorStatusMap.ts';
import { HttpStatus } from '../httpStatus.ts';

const MALFORMED_JSON_MESSAGE = 'Malformed JSON body';
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

const isJsonParseError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Express identifies error handlers by their four-argument arity.
  void _next;
  if (err instanceof AppError) {
    res.status(errorStatusMap[err.code] ?? HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Malformed JSON body sent by the client
  if (isJsonParseError(err)) {
    res
      .status(HttpStatus.BAD_REQUEST)
      .json({ error: { code: HttpErrorCode.INVALID_JSON, message: MALFORMED_JSON_MESSAGE } });
    return;
  }

  req.log.error({ err }, 'Request failed');
  res
    .status(HttpStatus.INTERNAL_SERVER_ERROR)
    .json({ error: { code: ErrorCode.INTERNAL_ERROR, message: INTERNAL_ERROR_MESSAGE } });
};
