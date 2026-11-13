import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { env } from '../../src/config/env.ts';
import { createDb, type DbConnection } from '../../src/shared/infrastructure/db/client.ts';
import type { NewOperation } from '../../src/modules/cash-in/domain/entities/Operation.ts';
import { Currency } from '../../src/modules/cash-in/domain/value-objects/Currency.ts';
import { OperationStatus } from '../../src/modules/cash-in/domain/value-objects/OperationStatus.ts';
import type { SettleOutcome } from '../../src/modules/cash-in/domain/value-objects/SettleOutcome.ts';
import { ClaimOperation } from '../../src/modules/cash-in/application/use-cases/ClaimOperation.ts';
import { SettleOperation } from '../../src/modules/cash-in/application/use-cases/SettleOperation.ts';
import { MarkOperationUnknown } from '../../src/modules/cash-in/application/use-cases/MarkOperationUnknown.ts';
import { HandlePaymentWebhook } from '../../src/modules/cash-in/application/use-cases/HandlePaymentWebhook.ts';
import { DrizzleUnitOfWork } from '../../src/modules/cash-in/infrastructure/persistence/DrizzleUnitOfWork.ts';

/**
 * A "pod": its own connection pool plus the use cases wired to it. Two pods on the same
 * database reproduce the multi-pod scenarios of the challenge (R2.5).
 */
export interface CashInPod {
  connection: DbConnection;
  unitOfWork: DrizzleUnitOfWork;
  claimOperation: ClaimOperation;
  settleOperation: SettleOperation;
  markOperationUnknown: MarkOperationUnknown;
  handlePaymentWebhook: HandlePaymentWebhook;
}

export const createPod = (): CashInPod => {
  assert.equal(env.DB_NAME, 'cashin_test', 'Destructive fixtures must only use cashin_test');
  const connection = createDb(env);
  const unitOfWork = new DrizzleUnitOfWork(connection.db);
  return {
    connection,
    unitOfWork,
    claimOperation: new ClaimOperation({ unitOfWork }),
    settleOperation: new SettleOperation({ unitOfWork }),
    markOperationUnknown: new MarkOperationUnknown({ unitOfWork }),
    handlePaymentWebhook: new HandlePaymentWebhook({ unitOfWork }),
  };
};

export const closePods = async (...pods: CashInPod[]): Promise<void> => {
  await Promise.all(pods.map((pod) => pod.connection.pool.end()));
};

export const resetDatabase = async (pod: CashInPod): Promise<void> => {
  await pod.connection.db.execute(
    sql`TRUNCATE webhook_events, ledger_entries, operations, wallets RESTART IDENTITY CASCADE`,
  );
};

export const DEFAULT_AMOUNT_CENTS = 10000;
export const DEFAULT_USER_ID = 'user';

export const newOperation = (overrides: Partial<NewOperation> = {}): NewOperation => ({
  id: `op_${randomUUID().replaceAll('-', '')}`,
  idempotencyKey: randomUUID(),
  requestHash: 'hash',
  userId: DEFAULT_USER_ID,
  amountCents: DEFAULT_AMOUNT_CENTS,
  currency: Currency.PEN,
  paymentMethod: 'card',
  ...overrides,
});

export const approvedOutcome: SettleOutcome = {
  status: OperationStatus.COMPLETED,
  providerChargeId: 'ch_test',
};

export const declinedOutcome: SettleOutcome = {
  status: OperationStatus.FAILED,
  reason: 'declined',
};
