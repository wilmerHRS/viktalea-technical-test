import type { NewOperation, Operation } from '../entities/Operation.ts';
import type { OperationStatus } from '../value-objects/OperationStatus.ts';
import type { ChargeOutcome } from '../gateways/PaymentProvider.ts';
import type { WebhookEventResult } from '../value-objects/WebhookEventResult.ts';

export type { NewOperation } from '../entities/Operation.ts';
export type SettleOutcome =
  | { status: typeof OperationStatus.COMPLETED; providerChargeId: string }
  | { status: typeof OperationStatus.FAILED; reason: string };

export interface PaymentWebhookEvent {
  eventId: string;
  operationId: string;
  status: ChargeOutcome;
  providerChargeId?: string;
  payload: unknown;
}

export interface OperationRepository {
  claim(input: NewOperation): Promise<{ created: boolean; operation: Operation }>;
  findById(id: string): Promise<Operation | null>;
  markUnknown(id: string): Promise<void>;
  settle(id: string, outcome: SettleOutcome): Promise<{ applied: boolean; operation: Operation }>;
  /** The short reservation transaction is committed before returning. No provider calls here. */
  leasePendingBatch(olderThanMs: number, leaseMs: number, limit: number): Promise<Operation[]>;
  applyWebhookEvent(
    event: PaymentWebhookEvent,
  ): Promise<
    { duplicate: true } | { duplicate: false; result: WebhookEventResult; operation: Operation }
  >;
}
