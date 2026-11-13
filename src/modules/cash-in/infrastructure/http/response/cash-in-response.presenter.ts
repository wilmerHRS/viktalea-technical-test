import { HttpStatus } from '../../../../../shared/infrastructure/http/constants/http-status.constants.ts';
import type { CashInResult } from '../../../application/dtos/output/cash-in-result.dto.ts';
import { ApiOperationStatus } from '../../../domain/value-objects/operation-status.value-object.ts';

/** Segundos que el cliente debería esperar antes de reintentar una operación pendiente. */
export const PENDING_RETRY_AFTER_SECONDS = 2;

export interface CashInHttpResponse {
  status: HttpStatus;
  body: Record<string, unknown>;
  retryAfterSeconds: number | null;
}

/** Traduce el resultado de un cash-in a la respuesta HTTP del contrato (design §7). */
export const presentCashIn = (result: CashInResult): CashInHttpResponse => {
  const baseBody = {
    operation_id: result.operationId,
    status: result.status,
    amount: result.amount,
  };

  switch (result.status) {
    case ApiOperationStatus.COMPLETED:
      return {
        status: HttpStatus.OK,
        body: { ...baseBody, new_balance: result.newBalance },
        retryAfterSeconds: null,
      };
    case ApiOperationStatus.FAILED:
      return {
        status: HttpStatus.PAYMENT_REQUIRED,
        body: { ...baseBody, failure_reason: result.failureReason },
        retryAfterSeconds: null,
      };
    case ApiOperationStatus.PENDING:
      return {
        status: HttpStatus.ACCEPTED,
        body: baseBody,
        retryAfterSeconds: PENDING_RETRY_AFTER_SECONDS,
      };
  }
};
