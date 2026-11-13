import type { Router } from 'express';

/** Contrato que cada módulo expone a la app. */
export interface HttpModule {
  basePath: string;
  router: Router;
}
