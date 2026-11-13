import { ValidationError, type FieldError } from '../../../../shared/domain/errors/index.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UserProps {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface CreateUserProps {
  id: string;
  name: unknown;
  email: unknown;
}

export class User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: Date;

  private constructor({ id, name, email, createdAt }: UserProps) {
    this.id = id;
    this.name = name;
    this.email = email;
    this.createdAt = createdAt;
  }

  /** Builds a new, validated user. Throws ValidationError on invalid input. */
  static create({ id, name, email }: CreateUserProps): User {
    const errors: FieldError[] = [];
    if (typeof name !== 'string' || name.trim().length < 2) {
      errors.push({ field: 'name', message: 'name must have at least 2 characters' });
    }
    if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      errors.push({ field: 'email', message: 'email must be a valid email address' });
    }
    if (errors.length > 0) throw new ValidationError('Invalid user data', errors);

    return new User({
      id,
      name: (name as string).trim(),
      email: (email as string).toLowerCase(),
      createdAt: new Date(),
    });
  }

  /** Rehydrates a user from persistence without re-running creation rules. */
  static restore(props: UserProps): User {
    return new User(props);
  }
}
