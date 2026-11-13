import { z } from 'zod';

/**
 * Convierte un esquema zod en un JSON Schema para OpenAPI 3.1. Así la documentación sale de
 * los MISMOS validadores que usa la API y no puede quedar desalineada.
 */
export const toOpenApiSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, { io: 'input' });
  void _dialect;
  return jsonSchema;
};
