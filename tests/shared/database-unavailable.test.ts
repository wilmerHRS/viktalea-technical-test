import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDatabaseUnavailableError } from '../../src/shared/infrastructure/db/utils/database-unavailable.util.ts';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('isDatabaseUnavailableError (R8.1 → 503)', () => {
  const unavailable: Array<[string, unknown]> = [
    ['conexión rechazada', withCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED')],
    ['reinicio de la BD (57P01)', withCode('terminating connection', '57P01')],
    ['clase 08 de SQLSTATE', withCode('connection failure', '08006')],
    ['timeout del pool', new Error('timeout exceeded when trying to connect')],
    // Detectado en la validación en vivo: BD caída con conexiones ya abiertas en el pool.
    ['conexión perdida sin código', new Error('Connection terminated unexpectedly')],
    [
      'error de pg envuelto por Drizzle (cause)',
      new Error('Failed query: select …', { cause: new Error('Connection terminated') }),
    ],
  ];

  for (const [name, error] of unavailable) {
    it(`es "BD no disponible": ${name}`, () => {
      assert.equal(isDatabaseUnavailableError(error), true);
    });
  }

  const notUnavailable: Array<[string, unknown]> = [
    ['violación de UNIQUE (23505)', withCode('duplicate key value', '23505')],
    ['error de programación', new TypeError('x is not a function')],
    ['valor que no es un error', 'boom'],
  ];

  for (const [name, error] of notUnavailable) {
    it(`NO es "BD no disponible": ${name}`, () => {
      assert.equal(isDatabaseUnavailableError(error), false);
    });
  }
});
