import type { Operation } from '../../../domain/entities/operation.entity.ts';

/** Resultado de intentar llevar una operación a su estado final. */
export interface SettleResult {
  /** false si otra vía (respuesta de la API, webhook o reconciliador) ya la había finalizado. */
  applied: boolean;
  operation: Operation;
}
