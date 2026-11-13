import type { NewOperation, Operation } from '../entities/Operation.ts';
import type { SettleOutcome } from '../value-objects/SettleOutcome.ts';
import type { PaymentWebhookEvent } from '../value-objects/PaymentWebhookEvent.ts';
import type { WebhookEventResult } from '../value-objects/WebhookEventResult.ts';

export interface ClaimResult {
  created: boolean;
  operation: Operation;
}

export interface SettleResult {
  applied: boolean;
  operation: Operation;
}

interface DuplicateWebhookResult {
  duplicate: true;
}

interface AppliedWebhookResult {
  duplicate: false;
  result: WebhookEventResult;
  operation: Operation;
}

export type ApplyWebhookEventResult = DuplicateWebhookResult | AppliedWebhookResult;

export interface OperationRepository {
  claim(input: NewOperation): Promise<ClaimResult>;
  findById(id: string): Promise<Operation | null>;
  markUnknown(id: string): Promise<void>;
  settle(id: string, outcome: SettleOutcome): Promise<SettleResult>;
  /** Commits the reservation before returning, allowing provider I/O outside the transaction. */
  leasePendingBatch(olderThanMs: number, leaseMs: number, limit: number): Promise<Operation[]>;
  applyWebhookEvent(event: PaymentWebhookEvent): Promise<ApplyWebhookEventResult>;
}
