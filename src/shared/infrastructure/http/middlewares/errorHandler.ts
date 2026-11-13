import type { ErrorRequestHandler } from 'express';
import { AppError, ErrorCode } from '../../../domain/errors/index.ts';
import { errorStatusMap, HttpErrorCode } from '../errorStatusMap.ts';
import { HttpStatus } from '../httpStatus.ts';

const isJsonParseError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
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
      .json({ error: { code: HttpErrorCode.INVALID_JSON, message: 'Malformed JSON body' } });
    return;
  }

  req.log.error({ err }, 'Request failed');
  res
    .status(HttpStatus.INTERNAL_SERVER_ERROR)
    .json({ error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' } });
};
