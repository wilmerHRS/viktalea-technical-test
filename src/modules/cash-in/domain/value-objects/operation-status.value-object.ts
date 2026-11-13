export const OperationStatus = {
  PROCESSING: 'PROCESSING',
  UNKNOWN: 'UNKNOWN',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus];

export const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  [OperationStatus.PROCESSING]: [
    OperationStatus.UNKNOWN,
    OperationStatus.COMPLETED,
    OperationStatus.FAILED,
  ],
  [OperationStatus.UNKNOWN]: [OperationStatus.COMPLETED, OperationStatus.FAILED],
  [OperationStatus.COMPLETED]: [],
  [OperationStatus.FAILED]: [],
};

export const FINAL_STATUSES: readonly OperationStatus[] = Object.values(OperationStatus).filter(
  (status) => transitions[status].length === 0,
);
export const SETTLEABLE_STATUSES: readonly OperationStatus[] = Object.values(
  OperationStatus,
).filter((status) => transitions[status].some((target) => FINAL_STATUSES.includes(target)));

export const canTransition = (from: OperationStatus, to: OperationStatus): boolean =>
  transitions[from].includes(to);

export const ApiOperationStatus = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type ApiOperationStatus = (typeof ApiOperationStatus)[keyof typeof ApiOperationStatus];

export const toApiStatus = (status: OperationStatus): ApiOperationStatus => {
  switch (status) {
    case OperationStatus.PROCESSING:
    case OperationStatus.UNKNOWN:
      return ApiOperationStatus.PENDING;
    case OperationStatus.COMPLETED:
      return ApiOperationStatus.COMPLETED;
    case OperationStatus.FAILED:
      return ApiOperationStatus.FAILED;
  }
};
