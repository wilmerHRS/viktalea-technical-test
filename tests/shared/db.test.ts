import { it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { env } from '../../src/config/env.ts';
import { createDb } from '../../src/shared/infrastructure/db/client.ts';

it('executes select 1 with Drizzle against cashin_test', async () => {
  assert.equal(env.DB_NAME, 'cashin_test');
  const { db, pool } = createDb(env);
  try {
    const result = await db.execute<{ value: number }>(sql`select 1 as value`);
    assert.equal(result.rows[0]?.value, 1);
  } finally {
    await pool.end();
  }
});
