import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import express from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.ts';

it('health echoes correlation ID and emits JSON logs with requestId', async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const app = createApp([], { logger: pino(stream) });
  const res = await request(app).get('/health').set('X-Request-Id', 'test-request').expect(200);
  assert.equal(res.headers['x-request-id'], 'test-request');
  assert.deepEqual(res.body, { status: 'ok' });
  const entry: Record<string, unknown> = JSON.parse(lines[0]!);
  assert.equal(entry.requestId, 'test-request');
  assert.equal(entry.statusCode, 200);
});

it('generates a UUID when request ID is absent', async () => {
  const app = createApp([]);
  const res = await request(app).get('/health').expect(200);
  const requestId = res.headers['x-request-id'];
  assert.ok(requestId);
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('mounts modules at the root', async () => {
  const router = express.Router().get('/', (_req, res) => {
    res.json({ data: 'root' });
  });
  const app = createApp([{ basePath: '/example', router }]);
  await request(app).get('/example').expect(200, { data: 'root' });
  await request(app).get('/api/v1/example').expect(404);
});

it('preserves valid request IDs up to the 128 character boundary', async () => {
  const app = createApp([]);
  for (const value of ['A', 'abc.ABC_012-xyz', 'x'.repeat(128)]) {
    const res = await request(app).get('/health').set('X-Request-Id', value).expect(200);
    assert.equal(res.headers['x-request-id'], value);
  }
});

it('replaces invalid or overlong incoming request IDs with a UUID', async () => {
  const app = createApp([]);
  for (const value of ['bad/request', 'has space', 'x'.repeat(129), '']) {
    const res = await request(app).get('/health').set('X-Request-Id', value).expect(200);
    const requestId = res.headers['x-request-id'];
    assert.ok(requestId);
    assert.notEqual(requestId, value);
    assert.match(
      requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
});
