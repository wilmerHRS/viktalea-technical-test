import type { User } from '../entities/User.ts';

/**
 * Port (contract) that any user persistence adapter must implement.
 * The domain and application layers depend only on this abstraction.
 */
export interface UserRepository {
  findAll(): Promise<User[]>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<User>;
}
