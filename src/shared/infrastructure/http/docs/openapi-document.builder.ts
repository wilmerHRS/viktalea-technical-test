import type { HttpModule } from '../interfaces/http-module.interface.ts';

const OPENAPI_VERSION = '3.1.0';

export const API_INFO = {
  title: 'Wallet Cash-In API',
  version: '1.0.0',
  description:
    'Recarga de saldo vía pasarela de pagos externa, con idempotencia real entre pods, ' +
    'máquina de estados, webhooks duplicados/fuera de orden y reconciliación. ' +
    'Todas las respuestas incluyen el header `X-Request-Id` (correlation ID).',
};

/** Une la documentación de todos los módulos en un único documento OpenAPI 3.1. */
export const buildOpenApiDocument = (modules: HttpModule[]): Record<string, unknown> => {
  const documented = modules.flatMap((module) => (module.docs ? [module.docs] : []));
  return {
    openapi: OPENAPI_VERSION,
    info: API_INFO,
    tags: documented.flatMap((docs) => docs.tags ?? []),
    paths: Object.assign({}, ...documented.map((docs) => docs.paths)),
    components: {
      schemas: Object.assign({}, ...documented.map((docs) => docs.schemas ?? {})),
      securitySchemes: Object.assign({}, ...documented.map((docs) => docs.securitySchemes ?? {})),
    },
  };
};
