import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Env } from '../../../config/env.ts';
import * as schema from './schema.ts';

export type DbConfig = Pick<Env, 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'>;

export const createDb = (config: DbConfig): { db: Db; pool: Pool } => {
  const pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionTimeoutMillis: 5000,
  });
  return { db: drizzle(pool, { schema }), pool };
};

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
