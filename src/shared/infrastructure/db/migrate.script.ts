import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../../../config/env.config.ts';
import { createDb } from './db.client.ts';

const { db, pool } = createDb(env);
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Database migrations applied');
} finally {
  await pool.end();
}
