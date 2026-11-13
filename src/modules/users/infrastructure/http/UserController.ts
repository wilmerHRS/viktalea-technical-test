import type { Request, Response } from 'express';
import type { CreateUser } from '../../application/use-cases/CreateUser.ts';
import type { GetUserById } from '../../application/use-cases/GetUserById.ts';
import type { ListUsers } from '../../application/use-cases/ListUsers.ts';

export interface UserControllerDeps {
  createUser: CreateUser;
  getUserById: GetUserById;
  listUsers: ListUsers;
}

export class UserController {
  private readonly createUser: CreateUser;
  private readonly getUserById: GetUserById;
  private readonly listUsers: ListUsers;

  constructor({ createUser, getUserById, listUsers }: UserControllerDeps) {
    this.createUser = createUser;
    this.getUserById = getUserById;
    this.listUsers = listUsers;
  }

  // Express 5 forwards rejected promises to the error handler automatically.
  list = async (_req: Request, res: Response): Promise<void> => {
    const users = await this.listUsers.execute();
    res.json({ data: users });
  };

  getById = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = await this.getUserById.execute(req.params.id);
    res.json({ data: user });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const user = await this.createUser.execute(req.body ?? {});
    res.status(201).json({ data: user });
  };
}
