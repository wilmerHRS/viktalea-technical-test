import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { logger } from '../../logging/logger.ts';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

export const createRequestId =
  (baseLogger: Logger = logger): RequestHandler =>
  (req, res, next): void => {
    const incomingId = req.get('X-Request-Id');
    req.requestId = incomingId && VALID_REQUEST_ID.test(incomingId) ? incomingId : randomUUID();
    req.log = baseLogger.child({ requestId: req.requestId });
    res.setHeader('X-Request-Id', req.requestId);
    res.on('finish', () => {
      req.log.info(
        { method: req.method, path: req.path, statusCode: res.statusCode },
        'Request completed',
      );
    });
    next();
  };
