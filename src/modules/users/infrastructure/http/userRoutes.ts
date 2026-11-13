import { Router } from 'express';
import type { UserController } from './UserController.ts';

export const buildUserRouter = (controller: UserController): Router => {
  const router = Router();
  router.get('/', controller.list);
  router.get('/:id', controller.getById);
  router.post('/', controller.create);
  return router;
};
