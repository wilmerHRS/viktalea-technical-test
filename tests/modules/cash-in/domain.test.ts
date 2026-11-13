import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, toApiStatus, OperationStatus } from '../../../src/modules/cash-in/domain/OperationStatus.ts';
import { toCents, fromCents } from '../../../src/modules/cash-in/domain/Money.ts';
import { Operation, type NewOperation } from '../../../src/modules/cash-in/domain/Operation.ts';
import { ValidationError } from '../../../src/shared/domain/errors/index.ts';

describe('OperationStatus (R3)', () => {
  const allowed = new Set(['PROCESSING:UNKNOWN', 'PROCESSING:COMPLETED', 'PROCESSING:FAILED', 'UNKNOWN:COMPLETED', 'UNKNOWN:FAILED']);
  for (const from of Object.values(OperationStatus)) {
    for (const to of Object.values(OperationStatus)) {
      it(`${from} -> ${to}`, () => assert.equal(canTransition(from, to), allowed.has(`${from}:${to}`)));
    }
  }
  it('maps all states to the API', () => {
    assert.equal(toApiStatus('PROCESSING'), 'pending');
    assert.equal(toApiStatus('UNKNOWN'), 'pending');
    assert.equal(toApiStatus('COMPLETED'), 'completed');
    assert.equal(toApiStatus('FAILED'), 'failed');
  });
});

describe('Money (R6.4, R1.3)', () => {
  it('converts decimal amounts to whole cents and back', () => {
    for (const [amount, cents] of [[100, 10000], [0.01, 1], [0.29, 29], [10.99, 1099], [1.23, 123]] as const) {
      assert.equal(toCents(amount), cents);
      assert.equal(fromCents(cents), amount);
    }
    assert.equal(fromCents(0), 0);
  });
  it('accepts floating point representation noise', () => assert.equal(toCents(0.1 + 0.2), 30));
  for (const amount of [1.005, 0.001, 10.999, 0, -1, NaN, Infinity, -Infinity, '100', null, undefined, {}, Number.MAX_VALUE]) {
    it(`rejects invalid amount ${String(amount)}`, () => assert.throws(() => toCents(amount), ValidationError));
  }
});

describe('Operation', () => {
  const input: NewOperation = { id: 'op_test', idempotencyKey: '6e06706c-711f-4f34-9d55-a16796f62d56',
    requestHash: 'hash', userId: 'user', amountCents: 10000, currency: 'PEN', paymentMethod: 'card' };
  it('creates a processing operation without a balance or provider result', () => {
    const op = Operation.create(input);
    assert.equal(op.status, 'PROCESSING');
    assert.equal(op.amountCents, 10000);
    assert.equal(op.newBalanceCents, null);
    assert.equal(op.providerChargeId, null);
    assert.equal(op.failureReason, null);
    assert.equal(op.reconcileLockedUntil, null);
    assert.ok(op.createdAt instanceof Date);
  });
  it('reports all invalid business fields', () => {
    assert.throws(() => Operation.create({ ...input, userId: ' ', paymentMethod: '', amountCents: 1.5, currency: 'USD' }),
      (err: unknown) => err instanceof ValidationError && Array.isArray(err.details) && err.details.length === 4);
  });
  it('restores persisted state without rerunning creation validation', () => {
    const data = { ...Operation.create(input), status: 'COMPLETED' as const, newBalanceCents: 10000 };
    assert.deepEqual({ ...Operation.restore(data) }, data);
  });
});
