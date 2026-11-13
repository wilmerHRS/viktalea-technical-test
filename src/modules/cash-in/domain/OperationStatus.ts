export const OperationStatus = {
  PROCESSING: 'PROCESSING', UNKNOWN: 'UNKNOWN', COMPLETED: 'COMPLETED', FAILED: 'FAILED',
} as const;
export type OperationStatus = typeof OperationStatus[keyof typeof OperationStatus];

export const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  PROCESSING: ['UNKNOWN', 'COMPLETED', 'FAILED'],
  UNKNOWN: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export const canTransition = (from: OperationStatus, to: OperationStatus): boolean => transitions[from].includes(to);

export const toApiStatus = (status: OperationStatus): 'pending' | 'completed' | 'failed' => {
  switch (status) {
    case 'PROCESSING':
    case 'UNKNOWN': return 'pending';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
  }
};
