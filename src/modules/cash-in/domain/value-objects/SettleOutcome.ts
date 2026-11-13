import type { OperationStatus } from './OperationStatus.ts';

export type SettleOutcome =
  | { status: typeof OperationStatus.COMPLETED; providerChargeId: string }
  | { status: typeof OperationStatus.FAILED; reason: string };
