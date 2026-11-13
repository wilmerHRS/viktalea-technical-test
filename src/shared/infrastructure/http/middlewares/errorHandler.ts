import type { ErrorRequestHandler } from 'express';
import { AppError } from '../../../domain/errors/index.ts';

const isJsonParseError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Malformed JSON body sent by the client
  if (isJsonParseError(err)) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};
