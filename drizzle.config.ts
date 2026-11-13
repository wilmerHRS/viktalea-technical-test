import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/cash-in/infrastructure/persistence/schema.ts',
  out: './drizzle',
});
