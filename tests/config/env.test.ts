import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env.ts';

const required = { DB_USER: 'cashin', DB_PASSWORD: 'cashin_local', DB_NAME: 'cashin_test', WEBHOOK_SECRET: 'local_webhook_secret_change_me' };

describe('loadEnv', () => {
  it('applies defaults alongside required variables', () => {
    assert.deepEqual(loadEnv(required), {
      ...required, NODE_ENV: 'development', PORT: 3000, CORS_ORIGIN: '*',
      DB_HOST: 'localhost', DB_PORT: 5432, PROVIDER_TIMEOUT_MS: 5000,
      RECONCILE_INTERVAL_MS: 30000, RECONCILE_AFTER_MS: 30000, RECONCILE_LEASE_MS: 60000, LOG_LEVEL: 'info',
    });
  });
  it('parses provided values', () => {
    const env = loadEnv({ ...required, NODE_ENV: 'production', PORT: '8080',
      CORS_ORIGIN: 'https://app.com, http://localhost:5173', DB_HOST: 'postgres', DB_PORT: '5433',
      PROVIDER_TIMEOUT_MS: '100', RECONCILE_INTERVAL_MS: '200', RECONCILE_AFTER_MS: '300',
      RECONCILE_LEASE_MS: '1000', LOG_LEVEL: 'debug' });
    assert.equal(env.PORT, 8080);
    assert.equal(env.NODE_ENV, 'production');
    assert.deepEqual(env.CORS_ORIGIN, ['https://app.com', 'http://localhost:5173']);
    assert.equal(env.DB_HOST, 'postgres');
    assert.equal(env.DB_PORT, 5433);
    assert.equal(env.PROVIDER_TIMEOUT_MS, 100);
    assert.equal(env.RECONCILE_INTERVAL_MS, 200);
    assert.equal(env.RECONCILE_AFTER_MS, 300);
    assert.equal(env.RECONCILE_LEASE_MS, 1000);
    assert.equal(env.LOG_LEVEL, 'debug');
  });
  for (const field of ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'WEBHOOK_SECRET']) {
    it(`requires ${field}`, () => {
      assert.throws(() => loadEnv({ ...required, [field]: undefined }), new RegExp(field));
      assert.throws(() => loadEnv({ ...required, [field]: '' }), new RegExp(field));
    });
  }
  for (const [field, values] of Object.entries({
    NODE_ENV: ['staging'], PORT: ['abc', '3000.5', '0', '70000'], DB_PORT: ['0', '65536', '1.5', 'abc'],
    DB_HOST: [''], WEBHOOK_SECRET: ['short'], LOG_LEVEL: ['silent'],
    PROVIDER_TIMEOUT_MS: ['0', '-1', '1.5', 'abc'], RECONCILE_INTERVAL_MS: ['0', '-1', '1.5'],
    RECONCILE_AFTER_MS: ['0', '-1', '1.5'], RECONCILE_LEASE_MS: ['0', '-1', '1.5'],
  })) {
    for (const value of values) {
      it(`rejects ${field}=${value}`, () => {
        assert.throws(() => loadEnv({ ...required, [field]: value }), new RegExp(field));
      });
    }
  }
  it('reports every invalid variable at once', () => {
    assert.throws(() => loadEnv({ ...required, NODE_ENV: 'staging', PORT: 'abc' }), /NODE_ENV[\s\S]*PORT|PORT[\s\S]*NODE_ENV/);
  });
});
