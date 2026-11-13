export interface FieldError {
  field: string;
  message: string;
}

interface AppErrorOptions {
  code?: string;
  details?: unknown;
}

export const ErrorCode = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_IDEMPOTENCY_KEY: 'INVALID_IDEMPOTENCY_KEY',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

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

/** Falta el header Idempotency-Key o no es un UUID (R1.2). */
export class InvalidIdempotencyKeyError extends AppError {
  constructor(message = 'Idempotency-Key header must be a UUID') {
    super(message, { code: ErrorCode.INVALID_IDEMPOTENCY_KEY });
  }
}

/** La misma Idempotency-Key llegó con un payload distinto (R2.4). */
export class IdempotencyKeyReusedError extends AppError {
  constructor(message = 'Idempotency-Key was already used with a different payload') {
    super(message, { code: ErrorCode.IDEMPOTENCY_KEY_REUSED });
  }
}
