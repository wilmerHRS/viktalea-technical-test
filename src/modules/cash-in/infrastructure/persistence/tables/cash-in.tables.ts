import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  char,
  bigint,
  bigserial,
  timestamp,
  uuid,
  jsonb,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { Currency } from '../../../domain/value-objects/currency.value-object.ts';
import {
  OperationStatus,
  SETTLEABLE_STATUSES,
} from '../../../domain/value-objects/operation-status.value-object.ts';
import { WebhookEventResult } from '../../../domain/value-objects/webhook-event-result.value-object.ts';
import { sqlInList } from '../../../../../shared/infrastructure/db/utils/sql-in-list.util.ts';

export const wallets = pgTable(
  'wallets',
  {
    userId: text('user_id').primaryKey(),
    currency: char('currency', { length: 3 }).notNull().default(Currency.PEN),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('wallets_balance_check', sql`${t.balanceCents} >= 0`)],
);

export const operations = pgTable(
  'operations',
  {
    id: text('id').primaryKey(),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => wallets.userId),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    paymentMethod: text('payment_method').notNull(),
    status: text('status').$type<OperationStatus>().notNull(),
    providerChargeId: text('provider_charge_id'),
    failureReason: text('failure_reason'),
    reconcileLockedUntil: timestamp('reconcile_locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('operations_amount_check', sql`${t.amountCents} > 0`),
    check(
      'operations_status_check',
      sql`${t.status} IN ${sqlInList(Object.values(OperationStatus))}`,
    ),
    index('operations_pending_idx')
      .on(t.status, t.updatedAt)
      .where(sql`${t.status} IN ${sqlInList(SETTLEABLE_STATUSES)}`),
  ],
);

export const ledgerEntries = pgTable('ledger_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  operationId: text('operation_id')
    .notNull()
    .unique()
    .references(() => operations.id),
  userId: text('user_id')
    .notNull()
    .references(() => wallets.userId),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  balanceAfterCents: bigint('balance_after_cents', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookEvents = pgTable(
  'webhook_events',
  {
    eventId: text('event_id').primaryKey(),
    operationId: text('operation_id').notNull(),
    status: text('status').notNull(),
    // NULL solo dentro de la transacción que inserta el evento; se completa antes del commit.
    result: text('result').$type<WebhookEventResult>(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'webhook_events_result_check',
      sql`${t.result} IN ${sqlInList(Object.values(WebhookEventResult))}`,
    ),
  ],
);
