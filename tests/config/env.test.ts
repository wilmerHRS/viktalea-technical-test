import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env.ts';

describe('loadEnv', () => {
  it('applies defaults when variables are missing', () => {
    assert.deepEqual(loadEnv({}), { NODE_ENV: 'development', PORT: 3000, CORS_ORIGIN: '*' });
  });

  it('parses provided values', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      CORS_ORIGIN: 'https://app.com, http://localhost:5173',
    });
    assert.deepEqual(env, {
      NODE_ENV: 'production',
      PORT: 8080,
      CORS_ORIGIN: ['https://app.com', 'http://localhost:5173'],
    });
  });

  it('rejects an unknown NODE_ENV', () => {
    assert.throws(() => loadEnv({ NODE_ENV: 'staging' }), /NODE_ENV/);
  });

  for (const port of ['abc', '3000.5', '0', '70000']) {
    it(`rejects PORT=${port}`, () => {
      assert.throws(() => loadEnv({ PORT: port }), /PORT/);
    });
  }

  it('reports every invalid variable at once', () => {
    assert.throws(() => loadEnv({ NODE_ENV: 'staging', PORT: 'abc' }), /NODE_ENV[\s\S]*PORT|PORT[\s\S]*NODE_ENV/);
  });
});
