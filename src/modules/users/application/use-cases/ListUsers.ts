import type { UserRepository } from '../../domain/repositories/UserRepository.ts';
import { toUserDto, type UserDto } from '../dtos/UserDto.ts';

export class ListUsers {
  private readonly userRepository: UserRepository;

  constructor({ userRepository }: { userRepository: UserRepository }) {
    this.userRepository = userRepository;
  }

  async execute(): Promise<UserDto[]> {
    const users = await this.userRepository.findAll();
    return users.map(toUserDto);
  }
}
