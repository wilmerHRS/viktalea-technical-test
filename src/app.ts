import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.ts';
import type { HttpModule } from './shared/infrastructure/http/HttpModule.ts';
import { errorHandler } from './shared/infrastructure/http/middlewares/errorHandler.ts';
import { notFound } from './shared/infrastructure/http/middlewares/notFound.ts';
import { createRequestId } from './shared/infrastructure/http/middlewares/requestId.ts';
import type { Logger } from 'pino';

/**
 * Builds the Express app and mounts the given modules at the root.
 * The modules are created by the caller (main.ts in production, each test in tests).
 */
export interface AppOptions {
  logger?: Logger;
}

export const createApp = (modules: HttpModule[], options: AppOptions = {}): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(createRequestId(options.logger));
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  for (const { basePath, router } of modules) {
    app.use(basePath, router);
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
