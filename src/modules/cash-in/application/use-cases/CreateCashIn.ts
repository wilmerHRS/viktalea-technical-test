import type { Logger } from 'pino';
import { IdempotencyKeyReusedError } from '../../../../shared/domain/errors/index.ts';
import { withTimeout } from '../../../../shared/utils/withTimeout.ts';
import { Operation } from '../../domain/entities/Operation.ts';
import {
  ChargeOutcome,
  type ChargeResult,
  type PaymentProvider,
} from '../../domain/gateways/PaymentProvider.ts';
import { ProviderTimeoutError } from '../../domain/gateways/PaymentProviderErrors.ts';
import type { Currency } from '../../domain/value-objects/Currency.ts';
import { toCents } from '../../domain/value-objects/Money.ts';
import { OperationStatus } from '../../domain/value-objects/OperationStatus.ts';
import type { SettleOutcome } from '../../domain/value-objects/SettleOutcome.ts';
import { toCashInResult, type CashInResult } from '../dtos/CashInResult.ts';
import type { UnitOfWork } from '../ports/UnitOfWork.ts';
import { hashCashInRequest } from '../services/requestHash.ts';
import type { ClaimOperation } from './ClaimOperation.ts';
import type { MarkOperationUnknown } from './MarkOperationUnknown.ts';
import type { SettleOperation } from './SettleOperation.ts';

/** Datos de entrada ya validados por la capa HTTP. */
export interface CreateCashInInput {
  idempotencyKey: string;
  userId: string;
  amount: number;
  currency: Currency;
  paymentMethod: string;
}

interface CreateCashInDependencies {
  unitOfWork: UnitOfWork;
  claimOperation: ClaimOperation;
  settleOperation: SettleOperation;
  markOperationUnknown: MarkOperationUnknown;
  paymentProvider: PaymentProvider;
  providerTimeoutMs: number;
  logger: Logger;
  generateOperationId?: () => string;
}

/**
 * POST /cash-in: cobra en la pasarela y acredita el saldo EXACTAMENTE una vez (R1, R2, R4).
 *
 * Responde la pregunta central del challenge: si la pasarela no responde, la operación queda
 * UNKNOWN y NO se reintenta el cobro. El reintento del cliente con la misma key devuelve el
 * estado actual, y la pasarela recibe siempre `operation.id` como su propia clave de idempotencia.
 */
export class CreateCashIn {
  private readonly deps: Required<CreateCashInDependencies>;

  constructor(dependencies: CreateCashInDependencies) {
    this.deps = { generateOperationId: Operation.newId, ...dependencies };
  }

  async execute(input: CreateCashInInput): Promise<CashInResult> {
    const amountCents = toCents(input.amount);
    const requestHash = hashCashInRequest({ ...input, amountCents });

    // 1. Registrar la operación (o encontrar la de esta key) ANTES de cobrar.
    const claim = await this.deps.claimOperation.execute({
      id: this.deps.generateOperationId(),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      userId: input.userId,
      amountCents,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
    });

    // 2. Repetición (doble click, retry de la app, otro pod): nunca se vuelve a cobrar (R2.2,
    // R2.3).
    if (!claim.created) {
      if (claim.operation.requestHash !== requestHash) {
        throw new IdempotencyKeyReusedError();
      }
      return toCashInResult(claim.operation);
    }

    // 3. Primera vez: cobrar FUERA de cualquier transacción y liquidar con lo que responda.
    const operation = await this.chargeAndSettle(claim.operation);
    return toCashInResult(operation);
  }

  private async chargeAndSettle(operation: Operation): Promise<Operation> {
    const log = this.deps.logger.child({ operationId: operation.id });
    let outcome: SettleOutcome;
    try {
      const charge = await withTimeout(
        this.deps.paymentProvider.charge({
          idempotencyKey: operation.id,
          amountCents: operation.amountCents,
          currency: operation.currency as Currency,
          paymentMethod: operation.paymentMethod,
        }),
        this.deps.providerTimeoutMs,
        () => new ProviderTimeoutError(),
      );
      outcome = this.toSettleOutcome(charge);
    } catch (error) {
      // Timeout o error de red: no sabemos si cobró. UNKNOWN y sin reintento (R4.4);
      // lo resolverá el webhook o el reconciliador.
      log.warn({ err: error }, 'Payment provider result unknown; operation marked UNKNOWN');
      await this.deps.markOperationUnknown.execute(operation.id);
      return this.readOperation(operation.id);
    }

    // Si un webhook ya la liquidó mientras esperábamos, settle no cambia nada y devuelve
    // la operación tal como quedó (R5.5).
    const settlement = await this.deps.settleOperation.execute(operation.id, outcome);
    log.info(
      { status: settlement.operation.status, applied: settlement.applied },
      'Cash-in settled',
    );
    return settlement.operation;
  }

  /** Respuesta de la pasarela → resultado con el que se liquida la operación. */
  private toSettleOutcome(charge: ChargeResult): SettleOutcome {
    if (charge.outcome === ChargeOutcome.APPROVED) {
      return { status: OperationStatus.COMPLETED, providerChargeId: charge.providerChargeId };
    }
    return { status: OperationStatus.FAILED, reason: charge.reason };
  }

  private async readOperation(operationId: string): Promise<Operation> {
    const operation = await this.deps.unitOfWork.run(({ operations }) =>
      operations.findById(operationId),
    );
    if (!operation) {
      throw new Error(`Cash-in operation ${operationId} disappeared`);
    }
    return operation;
  }
}
