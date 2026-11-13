import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Env } from '../../../config/env.ts';
import * as schema from './schema.ts';
import { logger } from '../logging/logger.ts';

export const DB_CONNECTION_TIMEOUT_MS = 5000;

export type DbConfig = Pick<Env, 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'>;

export interface DbConnection {
  db: Db;
  pool: Pool;
}

export const createDb = (config: DbConfig): DbConnection => {
  const pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  });
  // pg descarta la conexión inactiva caída; el pool abre una nueva en la siguiente consulta.
  pool.on('error', (err) => {
    logger.error({ err }, 'Idle database connection failed');
  });
  return { db: drizzle(pool, { schema }), pool };
};

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Cualquier cosa que ejecute consultas: el cliente del pool o una transacción abierta. */
export type DbExecutor = Db | Tx;
