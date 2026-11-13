import type { SettleOutcome } from '../../domain/value-objects/settle-outcome.value-object.ts';
import type { UnitOfWork } from '../ports/unit-of-work.port.ts';
import type { SettleResult } from '../dtos/output/settle-result.dto.ts';
import { settleOperation } from '../services/settle-operation.service.ts';

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
