import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { env } from '../../src/config/env.ts';
import { createDb } from '../../src/shared/infrastructure/db/client.ts';

it('survives 57P01 on an idle pool connection and executes the next query in the same process', { timeout: 15000 }, async () => {
  assert.equal(env.DB_NAME, 'cashin_test');
  const child = fork(fileURLToPath(new URL('../fixtures/poolRecovery.ts', import.meta.url)), [], {
    execArgv: ['--env-file=.env.test', '--import=tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 10000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const exited = once(child, 'close');
  const { db, pool } = createDb(env);
  try {
    const ready = once(child, 'message').then((args: unknown[]) => args[0]);
    const message = await Promise.race([ready, exited.then(() => { throw new Error(`Child exited before ready: ${stderr}`); })]);
    assert.ok(typeof message === 'object' && message !== null && 'backendPid' in message);
    assert.equal(typeof message.backendPid, 'number');
    const result = await db.execute<{ terminated: boolean }>(sql`
      select pg_terminate_backend(pid) as terminated from pg_stat_activity
      where pid = ${message.backendPid} and datname = ${env.DB_NAME} and state = 'idle'
    `);
    assert.equal(result.rows[0]?.terminated, true, 'Only terminate the known idle connection in cashin_test');
    if (child.connected) child.send('recover');
    const [code, signal] = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /"recovered":true/);
    const logs: unknown[] = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(logs.some((entry) => typeof entry === 'object' && entry !== null && 'err' in entry &&
      typeof entry.err === 'object' && entry.err !== null && 'code' in entry.err && entry.err.code === '57P01'),
    'The production pool error handler must log 57P01');
  } finally {
    if (child.exitCode === null) child.kill();
    await pool.end();
  }
});
