// Composition root of the "users" module: wires adapters -> use cases -> controller -> router.
import type { HttpModule } from '../../shared/infrastructure/http/HttpModule.ts';
import type { UserRepository } from './domain/repositories/UserRepository.ts';
import { InMemoryUserRepository } from './infrastructure/persistence/InMemoryUserRepository.ts';
import { CreateUser } from './application/use-cases/CreateUser.ts';
import { GetUserById } from './application/use-cases/GetUserById.ts';
import { ListUsers } from './application/use-cases/ListUsers.ts';
import { UserController } from './infrastructure/http/UserController.ts';
import { buildUserRouter } from './infrastructure/http/userRoutes.ts';

export interface UsersModuleOverrides {
  userRepository?: UserRepository;
}

export const createUsersModule = ({
  userRepository = new InMemoryUserRepository(),
}: UsersModuleOverrides = {}): HttpModule => {
  const controller = new UserController({
    createUser: new CreateUser({ userRepository }),
    getUserById: new GetUserById({ userRepository }),
    listUsers: new ListUsers({ userRepository }),
  });

  return { basePath: '/users', router: buildUserRouter(controller) };
};
