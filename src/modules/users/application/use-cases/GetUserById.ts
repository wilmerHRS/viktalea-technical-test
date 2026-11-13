import { NotFoundError } from '../../../../shared/domain/errors/index.ts';
import type { UserRepository } from '../../domain/repositories/UserRepository.ts';
import { toUserDto, type UserDto } from '../dtos/UserDto.ts';

export class GetUserById {
  private readonly userRepository: UserRepository;

  constructor({ userRepository }: { userRepository: UserRepository }) {
    this.userRepository = userRepository;
  }

  async execute(id: string): Promise<UserDto> {
    const user = await this.userRepository.findById(id);
    if (!user) throw new NotFoundError(`User ${id} not found`);
    return toUserDto(user);
  }
}
