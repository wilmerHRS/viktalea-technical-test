import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

export const DocsPath = {
  UI: '/docs',
  OPENAPI_JSON: '/docs/openapi.json',
} as const;

/** Swagger UI en /docs y el documento OpenAPI en crudo en /docs/openapi.json. */
export const buildDocsRouter = (openApiDocument: Record<string, unknown>): Router => {
  const router = Router();
  router.get(DocsPath.OPENAPI_JSON, (_req, res) => {
    res.json(openApiDocument);
  });
  router.use(DocsPath.UI, swaggerUi.serve, swaggerUi.setup(openApiDocument));
  return router;
};
