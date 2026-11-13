import { it } from 'node:test';
import assert from 'node:assert/strict';
import { toSettleOutcome } from '../../../src/modules/cash-in/domain/value-objects/PaymentWebhookEvent.ts';

it('maps an approved webhook to a completed outcome with its charge ID', () => {
  const event = {
    eventId: 'evt_approved',
    operationId: 'op_test',
    status: 'approved' as const,
    providerChargeId: 'ch_test',
    payload: {},
  };
  const expected = { status: 'COMPLETED', providerChargeId: 'ch_test' };
  assert.deepEqual(toSettleOutcome(event), expected);
});

it('maps a declined webhook to a failed outcome with the default reason', () => {
  const event = {
    eventId: 'evt_declined',
    operationId: 'op_test',
    status: 'declined' as const,
    payload: {},
  };
  const expected = { status: 'FAILED', reason: 'Payment declined' };
  assert.deepEqual(toSettleOutcome(event), expected);
});
