import type { SettleOutcome } from '../../domain/value-objects/SettleOutcome.ts';
import type { UnitOfWork } from '../ports/UnitOfWork.ts';
import { settleOperation, type SettleResult } from '../services/settleOperation.ts';

interface SettleOperationDependencies {
  unitOfWork: UnitOfWork;
}

/** Finaliza una operación en su propia transacción. Los pasos están en `settleOperation`. */
export class SettleOperation {
  private readonly unitOfWork: UnitOfWork;

  constructor({ unitOfWork }: SettleOperationDependencies) {
    this.unitOfWork = unitOfWork;
  }

  async execute(operationId: string, outcome: SettleOutcome): Promise<SettleResult> {
    return this.unitOfWork.run((repositories) =>
      settleOperation(repositories, operationId, outcome),
    );
  }
}
