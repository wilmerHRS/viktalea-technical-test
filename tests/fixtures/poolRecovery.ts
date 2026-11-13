import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { env } from '../../src/config/env.ts';
import { createDb } from '../../src/shared/infrastructure/db/client.ts';

assert.equal(env.DB_NAME, 'cashin_test');
const { db, pool } = createDb(env);
try {
  const backend = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  assert.equal(pool.idleCount, 1);
  const recoverCommand = once(process, 'message');
  process.send!({ backendPid: backend.rows[0]!.pid });
  await recoverCommand;

  // Do not attach an 'error' listener here: the production handler must keep this process alive.
  const deadline = Date.now() + 5000;
  while (pool.totalCount !== 0 && Date.now() < deadline) await setTimeout(10);
  assert.equal(pool.totalCount, 0, 'pg must discard the failed idle connection');
  const result = await db.execute<{ value: number }>(sql`select 1 as value`);
  assert.equal(result.rows[0]!.value, 1);
  console.log(JSON.stringify({ recovered: true }));
} finally {
  await pool.end();
  process.disconnect?.();
}
