import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_HOST: z.string().min(1).default('localhost'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(16),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  RECONCILE_AFTER_MS: z.coerce.number().int().positive().default(30000),
  RECONCILE_LEASE_MS: z.coerce.number().int().positive().default(60000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // '*' or a comma-separated list: "https://app.com,http://localhost:5173"
  CORS_ORIGIN: z
    .string()
    .default('*')
    .transform((value) => (value === '*' ? '*' : value.split(',').map((origin) => origin.trim()))),
});

export type Env = z.infer<typeof envSchema>;

/** Validates the given variables. Throws listing every invalid one. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
};

// Fail fast: don't start the app with a bad configuration.
const init = (): Env => {
  try {
    return loadEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

export const env = init();
