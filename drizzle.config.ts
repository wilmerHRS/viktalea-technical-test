import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/cash-in/infrastructure/persistence/tables/cash-in.tables.ts',
  out: './drizzle',
});
