import type { RequestHandler } from 'express';
import { HttpStatus } from '../constants/http-status.constants.ts';
import { HttpErrorCode } from '../constants/error-status.constants.ts';

export const notFound: RequestHandler = (req, res) => {
  res.status(HttpStatus.NOT_FOUND).json({
    error: {
      code: HttpErrorCode.ROUTE_NOT_FOUND,
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
};
