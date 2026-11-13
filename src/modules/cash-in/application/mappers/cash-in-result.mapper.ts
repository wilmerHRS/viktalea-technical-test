import type { Operation } from '../../domain/entities/operation.entity.ts';
import { fromCents } from '../../domain/value-objects/money.value-object.ts';
import { toApiStatus } from '../../domain/value-objects/operation-status.value-object.ts';
import type { CashInResult } from '../dtos/output/cash-in-result.dto.ts';

/** Entidad → resultado para el cliente (céntimos → unidades, estado interno → estado de la API). */
export const toCashInResult = (operation: Operation): CashInResult => ({
  operationId: operation.id,
  status: toApiStatus(operation.status),
  amount: fromCents(operation.amountCents),
  newBalance: operation.newBalanceCents === null ? null : fromCents(operation.newBalanceCents),
  failureReason: operation.failureReason,
});
