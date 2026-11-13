import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../../../config/env.ts';
import { createDb } from './client.ts';

const { db, pool } = createDb(env);
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Database migrations applied');
} finally {
  await pool.end();
}
