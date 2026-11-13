import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { logger } from '../../logging/logger.ts';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

export const createRequestId = (baseLogger: Logger = logger): RequestHandler => (req, res, next): void => {
  req.requestId = req.get('X-Request-Id') || randomUUID();
  req.log = baseLogger.child({ requestId: req.requestId });
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', () => {
    req.log.info({ method: req.method, path: req.path, statusCode: res.statusCode }, 'Request completed');
  });
  next();
};
