import { OperationStatus } from '../../domain/value-objects/operation-status.value-object.ts';
import type { UnitOfWork } from '../ports/unit-of-work.port.ts';

interface MarkOperationUnknownDependencies {
  unitOfWork: UnitOfWork;
}

/**
 * La pasarela no respondió (timeout o error de red): no sabemos si cobró.
 * La operación pasa a UNKNOWN y NO se reintenta el cobro; la resuelve un webhook o el
 * reconciliador (R4.4). Si un webhook ya la finalizó, no hace nada.
 */
export class MarkOperationUnknown {
  private readonly unitOfWork: UnitOfWork;

  constructor({ unitOfWork }: MarkOperationUnknownDependencies) {
    this.unitOfWork = unitOfWork;
  }

  async execute(operationId: string): Promise<void> {
    await this.unitOfWork.run(({ operations }) =>
      operations.changeStatus(operationId, {
        from: [OperationStatus.PROCESSING],
        to: OperationStatus.UNKNOWN,
      }),
    );
  }
}
