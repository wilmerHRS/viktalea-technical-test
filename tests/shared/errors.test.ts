import { it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../src/app.ts';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../../src/shared/domain/errors/index.ts';

for (const [error, status, expected] of [
  [
    new ValidationError('Bad input', [{ field: 'name', message: 'Required' }]),
    400,
    {
      code: 'VALIDATION_ERROR',
      message: 'Bad input',
      details: [{ field: 'name', message: 'Required' }],
    },
  ],
  [new NotFoundError('Missing'), 404, { code: 'NOT_FOUND', message: 'Missing' }],
  [new ConflictError('Duplicate'), 409, { code: 'CONFLICT', message: 'Duplicate' }],
  [new AppError('Internal'), 500, { code: 'INTERNAL_ERROR', message: 'Internal' }],
  [
    new AppError('Unmapped', { code: 'UNMAPPED_TEST_ERROR' }),
    500,
    { code: 'UNMAPPED_TEST_ERROR', message: 'Unmapped' },
  ],
] as const) {
  it(`maps ${error.code} to HTTP ${status} without statusCode in domain`, async () => {
    assert.equal('statusCode' in error, false);
    const router = express.Router().get('/', () => {
      throw error;
    });
    const app = createApp([{ basePath: '/error', router }]);
    await request(app).get('/error').expect(status, { error: expected });
  });
}

it('preserves the route-not-found and malformed JSON responses', async () => {
  const app = createApp([]);
  await request(app)
    .get('/missing')
    .expect(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Route GET /missing not found' } });
  await request(app)
    .post('/missing')
    .set('Content-Type', 'application/json')
    .send('{')
    .expect(400, { error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
});

it('does not expose internal exception details', async () => {
  const router = express.Router().get('/', () => {
    throw new Error('Private database connection details');
  });
  const app = createApp([{ basePath: '/error', router }], { logger: pino({ enabled: false }) });
  await request(app)
    .get('/error')
    .expect(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});
