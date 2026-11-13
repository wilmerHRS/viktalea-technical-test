import type { RequestHandler } from 'express';
import { HttpStatus } from '../http-status.constants.ts';
import { HttpErrorCode } from '../error-status.map.ts';

export const notFound: RequestHandler = (req, res) => {
  res.status(HttpStatus.NOT_FOUND).json({
    error: {
      code: HttpErrorCode.ROUTE_NOT_FOUND,
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
};
