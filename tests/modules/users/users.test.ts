import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../src/app.ts';
import { createUsersModule } from '../../../src/modules/users/index.ts';
import { CreateUser } from '../../../src/modules/users/application/use-cases/CreateUser.ts';
import { InMemoryUserRepository } from '../../../src/modules/users/infrastructure/persistence/InMemoryUserRepository.ts';
import { ConflictError, ValidationError } from '../../../src/shared/domain/errors/index.ts';

describe('CreateUser use case', () => {
  let createUser: CreateUser;

  beforeEach(() => {
    createUser = new CreateUser({
      userRepository: new InMemoryUserRepository(),
      idGenerator: () => 'fixed-id',
    });
  });

  it('creates a user with normalized email', async () => {
    const user = await createUser.execute({ name: ' Ana ', email: 'ANA@mail.com' });
    assert.equal(user.id, 'fixed-id');
    assert.equal(user.name, 'Ana');
    assert.equal(user.email, 'ana@mail.com');
  });

  it('rejects invalid data', async () => {
    await assert.rejects(createUser.execute({ name: 'A', email: 'nope' }), ValidationError);
  });

  it('rejects duplicated email', async () => {
    await createUser.execute({ name: 'Ana', email: 'ana@mail.com' });
    await assert.rejects(createUser.execute({ name: 'Ana 2', email: 'ana@mail.com' }), ConflictError);
  });
});

describe('Users HTTP API', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp([createUsersModule({ userRepository: new InMemoryUserRepository() })]);
  });

  it('POST /api/v1/users -> 201 and GET by id -> 200', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .send({ name: 'Luis', email: 'luis@mail.com' })
      .expect(201);

    const { id } = created.body.data as { id: string };
    const fetched = await request(app).get(`/api/v1/users/${id}`).expect(200);
    assert.equal(fetched.body.data.email, 'luis@mail.com');
  });

  it('GET unknown user -> 404', async () => {
    const res = await request(app).get('/api/v1/users/does-not-exist').expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('POST invalid body -> 400', async () => {
    const res = await request(app).post('/api/v1/users').send({ name: 'x' }).expect(400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('GET /health -> 200', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' });
  });
});
