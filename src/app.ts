import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.config.ts';
import { buildOpenApiDocument } from './shared/infrastructure/http/docs/openapi-document.builder.ts';
import type { HttpModule } from './shared/infrastructure/http/interfaces/http-module.interface.ts';
import { buildDocsRouter } from './shared/infrastructure/http/routes/docs.routes.ts';
import { errorHandler } from './shared/infrastructure/http/middlewares/error-handler.middleware.ts';
import { notFound } from './shared/infrastructure/http/middlewares/not-found.middleware.ts';
import { createRequestId } from './shared/infrastructure/http/middlewares/request-id.middleware.ts';
import { captureRawBody } from './shared/infrastructure/http/utils/raw-body.util.ts';
import type { Logger } from 'pino';

export interface AppOptions {
  logger?: Logger;
}

/**
 * Construye la app de Express y monta en la raíz los módulos recibidos.
 * Los módulos los crea quien llama (main.ts en producción, cada test en los tests).
 */
export const createApp = (modules: HttpModule[], options: AppOptions = {}): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(createRequestId(options.logger));
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  // Se guarda también el body crudo: la firma de los webhooks se verifica sobre esos bytes.
  app.use(express.json({ verify: captureRawBody }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Documentación de las APIs: Swagger UI en /docs y el JSON en /docs/openapi.json.
  app.use(buildDocsRouter(buildOpenApiDocument(modules)));

  for (const { basePath, router } of modules) {
    app.use(basePath, router);
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
