import { ValidationError, type FieldError } from '../../../shared/domain/errors/index.ts';
import type { OperationStatus } from './OperationStatus.ts';

export interface NewOperation {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  userId: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
}

export interface OperationData extends NewOperation {
  status: OperationStatus;
  providerChargeId: string | null;
  failureReason: string | null;
  reconcileLockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  newBalanceCents: number | null;
}

export class Operation implements Readonly<OperationData> {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly userId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly paymentMethod: string;
  readonly status: OperationStatus;
  readonly providerChargeId: string | null;
  readonly failureReason: string | null;
  readonly reconcileLockedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly newBalanceCents: number | null;

  private constructor(data: OperationData) {
    this.id = data.id;
    this.idempotencyKey = data.idempotencyKey;
    this.requestHash = data.requestHash;
    this.userId = data.userId;
    this.amountCents = data.amountCents;
    this.currency = data.currency;
    this.paymentMethod = data.paymentMethod;
    this.status = data.status;
    this.providerChargeId = data.providerChargeId;
    this.failureReason = data.failureReason;
    this.reconcileLockedUntil = data.reconcileLockedUntil;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.newBalanceCents = data.newBalanceCents;
  }

  static create(input: NewOperation): Operation {
    const details: FieldError[] = [];
    for (const [field, value] of [['user_id', input.userId], ['payment_method', input.paymentMethod]] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) details.push({ field, message: 'Must be a non-empty string' });
    }
    if (input.currency !== 'PEN') details.push({ field: 'currency', message: 'Must be PEN' });
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      details.push({ field: 'amount', message: 'Must be a positive integer number of cents' });
    }
    if (details.length > 0) throw new ValidationError('Invalid cash-in operation', details);
    const now = new Date();
    return new Operation({ ...input, status: 'PROCESSING', providerChargeId: null, failureReason: null,
      reconcileLockedUntil: null, createdAt: now, updatedAt: now, newBalanceCents: null });
  }

  static restore(data: OperationData): Operation { return new Operation(data); }
}
