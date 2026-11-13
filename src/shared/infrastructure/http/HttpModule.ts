import type { Router } from 'express';

/** Contract every feature module exposes to the app. */
export interface HttpModule {
  basePath: string;
  router: Router;
}
