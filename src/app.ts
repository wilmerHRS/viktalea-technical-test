import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.ts';
import type { HttpModule } from './shared/infrastructure/http/HttpModule.ts';
import { errorHandler } from './shared/infrastructure/http/middlewares/errorHandler.ts';
import { notFound } from './shared/infrastructure/http/middlewares/notFound.ts';

/**
 * Builds the Express app and mounts the given modules under /api/v1.
 * The modules are created by the caller (main.ts in production, each test in tests).
 */
export const createApp = (modules: HttpModule[]): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const api = express.Router();
  for (const { basePath, router } of modules) {
    api.use(basePath, router);
  }
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
