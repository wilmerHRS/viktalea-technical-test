export interface FieldError {
  field: string;
  message: string;
}

interface AppErrorOptions {
  code?: string;
  details?: unknown;
}

export const ErrorCode = {
  INTERNAL_ERROR: 'INTERNAL_ERROR', VALIDATION_ERROR: 'VALIDATION_ERROR', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT',
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, { code = ErrorCode.INTERNAL_ERROR, details }: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: FieldError[]) {
    super(message, { code: ErrorCode.VALIDATION_ERROR, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { code: ErrorCode.NOT_FOUND });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, { code: ErrorCode.CONFLICT });
  }
}
