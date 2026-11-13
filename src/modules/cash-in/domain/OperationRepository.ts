import type { NewOperation, Operation } from './Operation.ts';

export type { NewOperation } from './Operation.ts';
export type SettleOutcome =
  | { status: 'COMPLETED'; providerChargeId: string }
  | { status: 'FAILED'; reason: string };

export interface WebhookEventInput {
  eventId: string;
  operationId: string;
  status: 'approved' | 'declined';
  result: 'applied' | 'ignored' | 'conflict';
  payload: unknown;
}

export interface OperationRepository {
  claim(input: NewOperation): Promise<{ created: boolean; operation: Operation }>;
  findById(id: string): Promise<Operation | null>;
  markUnknown(id: string): Promise<void>;
  settle(id: string, outcome: SettleOutcome): Promise<{ applied: boolean; operation: Operation }>;
  /** The short reservation transaction is committed before returning. No provider calls here. */
  leasePendingBatch(olderThanMs: number, leaseMs: number, limit: number): Promise<Operation[]>;
  recordWebhookEvent(e: WebhookEventInput): Promise<{ duplicate: boolean }>;
}
