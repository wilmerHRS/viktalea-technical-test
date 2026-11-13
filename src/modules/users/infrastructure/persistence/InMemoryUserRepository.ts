import type { User } from '../../domain/entities/User.ts';
import type { UserRepository } from '../../domain/repositories/UserRepository.ts';

export class InMemoryUserRepository implements UserRepository {
  readonly #users = new Map<string, User>();

  async findAll(): Promise<User[]> {
    return [...this.#users.values()];
  }

  async findById(id: string): Promise<User | null> {
    return this.#users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.#users.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async save(user: User): Promise<User> {
    this.#users.set(user.id, user);
    return user;
  }
}
