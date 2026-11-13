import type { User } from '../../domain/entities/User.ts';

export interface UserDto {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface CreateUserInput {
  name?: unknown;
  email?: unknown;
}

export const toUserDto = (user: User): UserDto => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt.toISOString(),
});
