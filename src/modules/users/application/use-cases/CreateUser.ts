import { randomUUID } from 'node:crypto';
import { ConflictError } from '../../../../shared/domain/errors/index.ts';
import { User } from '../../domain/entities/User.ts';
import type { UserRepository } from '../../domain/repositories/UserRepository.ts';
import { toUserDto, type CreateUserInput, type UserDto } from '../dtos/UserDto.ts';

export interface CreateUserDeps {
  userRepository: UserRepository;
  idGenerator?: () => string;
}

export class CreateUser {
  private readonly userRepository: UserRepository;
  private readonly idGenerator: () => string;

  constructor({ userRepository, idGenerator = randomUUID }: CreateUserDeps) {
    this.userRepository = userRepository;
    this.idGenerator = idGenerator;
  }

  async execute({ name, email }: CreateUserInput): Promise<UserDto> {
    const user = User.create({ id: this.idGenerator(), name, email });

    const existing = await this.userRepository.findByEmail(user.email);
    if (existing) throw new ConflictError(`User with email ${user.email} already exists`);

    const saved = await this.userRepository.save(user);
    return toUserDto(saved);
  }
}
