import type { z } from 'zod';
import { ValidationError, type FieldError } from '../../domain/errors/index.ts';

const ROOT_FIELD = 'body';

/** Convierte los errores de zod al formato de la API: `details: [{ field, message }]`. */
export const zodToValidationError = (error: z.ZodError, message: string): ValidationError => {
  const details: FieldError[] = error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : ROOT_FIELD,
    message: issue.message,
  }));
  return new ValidationError(message, details);
};
