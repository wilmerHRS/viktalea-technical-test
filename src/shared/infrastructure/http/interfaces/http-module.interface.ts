import type { Router } from 'express';
import type { OpenApiDocumentation } from './openapi-documentation.interface.ts';

/** Contrato que cada módulo expone a la app. */
export interface HttpModule {
  basePath: string;
  router: Router;
  /** Documentación OpenAPI de las rutas del módulo; se publica en /docs. */
  docs?: OpenApiDocumentation;
}
