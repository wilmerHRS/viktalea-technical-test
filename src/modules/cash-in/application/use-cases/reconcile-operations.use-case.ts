import type { Logger } from 'pino';
import { withTimeout } from '../../../../shared/utils/with-timeout.util.ts';
import type { Operation } from '../../domain/entities/operation.entity.ts';
import {
  DEFAULT_DECLINE_REASON,
  ProviderChargeStatus,
  type ChargeStatusResult,
  type PaymentProvider,
} from '../../domain/gateways/payment-provider.gateway.ts';
import { ProviderTimeoutError } from '../../domain/gateways/payment-provider.errors.ts';
import { OperationStatus } from '../../domain/value-objects/operation-status.value-object.ts';
import type { SettleOutcome } from '../../domain/value-objects/settle-outcome.value-object.ts';
import type { UnitOfWork } from '../ports/unit-of-work.port.ts';
import type { SettleOperation } from './settle-operation.use-case.ts';

/** Operaciones que se reservan en cada ciclo; con el lease cubre lote × timeout (design §6.4). */
export const RECONCILE_BATCH_SIZE = 10;

/** Motivo con el que falla una operación que la pasarela nunca llegó a recibir. */
export const CHARGE_NOT_FOUND_REASON = 'Charge not found at payment provider';

export interface ReconcileSettings {
  /** Antigüedad a partir de la cual una operación en PROCESSING se considera atascada. */
  staleAfterMs: number;
  /** Duración de la reserva de cada operación. */
  leaseMs: number;
  /** Tiempo máximo de espera por cada consulta a la pasarela. */
  providerTimeoutMs: number;
}

/** Qué pasó en un ciclo de reconciliación (para logs y tests). */
export interface ReconcileSummary {
  reserved: number;
  completed: number;
  failed: number;
  stillPending: number;
  errors: number;
}

interface ReconcileOperationsDependencies {
  unitOfWork: UnitOfWork;
  settleOperation: SettleOperation;
  paymentProvider: PaymentProvider;
  settings: ReconcileSettings;
  logger: Logger;
}

/**
 * Resuelve las operaciones cuyo resultado no conocemos (R7): UNKNOWN tras un timeout, o
 * PROCESSING atascadas porque el pod se cayó a mitad del cobro (R8.2).
 *
 * Tres fases, y NINGUNA llamada a la pasarela con una transacción abierta (design §6.4):
 *   1. reservar un lote (transacción corta que se confirma al salir);
 *   2. preguntar a la pasarela por cada operación, fuera de cualquier transacción;
 *   3. liquidar con lo que responda (cada liquidación, en su propia transacción).
 *
 * Que dos pods reconcilien a la vez es seguro: la reserva reparte las operaciones, y aunque
 * una reserva venciera, `settleOperation` nunca acredita dos veces.
 */
export class ReconcileOperations {
  private readonly deps: ReconcileOperationsDependencies;

  constructor(dependencies: ReconcileOperationsDependencies) {
    this.deps = dependencies;
  }

  async execute(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      reserved: 0,
      completed: 0,
      failed: 0,
      stillPending: 0,
      errors: 0,
    };

    // 1. Reservar. `run` confirma la transacción al terminar, antes de consultar la pasarela.
    const reserved = await this.deps.unitOfWork.run(({ operations }) =>
      operations.leasePendingBatch({
        staleAfterMs: this.deps.settings.staleAfterMs,
        leaseMs: this.deps.settings.leaseMs,
        limit: RECONCILE_BATCH_SIZE,
      }),
    );
    summary.reserved = reserved.length;

    // 2 y 3. Una operación cada vez: un fallo en una no impide resolver las demás.
    for (const operation of reserved) {
      await this.reconcileOne(operation, summary);
    }

    if (summary.reserved > 0) {
      this.deps.logger.info(summary, 'Reconciliation cycle finished');
    }
    return summary;
  }

  private async reconcileOne(operation: Operation, summary: ReconcileSummary): Promise<void> {
    const log = this.deps.logger.child({ operationId: operation.id });
    try {
      const chargeStatus = await withTimeout(
        this.deps.paymentProvider.getChargeStatus(operation.id),
        this.deps.settings.providerTimeoutMs,
        () => new ProviderTimeoutError(),
      );

      const outcome = this.toSettleOutcome(chargeStatus);
      if (!outcome) {
        // La pasarela aún no lo sabe: se reintenta en el siguiente ciclo, cuando venza el lease.
        summary.stillPending++;
        return;
      }

      const settlement = await this.deps.settleOperation.execute(operation.id, outcome);
      if (settlement.operation.status === OperationStatus.COMPLETED) {
        summary.completed++;
      } else {
        summary.failed++;
      }
      log.info(
        { status: settlement.operation.status, applied: settlement.applied },
        'Operation reconciled',
      );
    } catch (error) {
      summary.errors++;
      log.warn({ err: error }, 'Could not reconcile operation; will retry when the lease expires');
    }
  }

  /** Estado del cobro en la pasarela → resultado con el que se liquida (null = aún pendiente). */
  private toSettleOutcome(chargeStatus: ChargeStatusResult): SettleOutcome | null {
    switch (chargeStatus.status) {
      case ProviderChargeStatus.APPROVED:
        if (!chargeStatus.providerChargeId) {
          return null;
        }
        return {
          status: OperationStatus.COMPLETED,
          providerChargeId: chargeStatus.providerChargeId,
        };
      case ProviderChargeStatus.DECLINED:
        return {
          status: OperationStatus.FAILED,
          reason: chargeStatus.reason ?? DEFAULT_DECLINE_REASON,
        };
      case ProviderChargeStatus.NOT_FOUND:
        // El cobro nunca llegó a la pasarela (p. ej. el pod se cayó antes de cobrar).
        return { status: OperationStatus.FAILED, reason: CHARGE_NOT_FOUND_REASON };
      default:
        return null;
    }
  }
}
