import { Operation } from '../../../domain/entities/operation.entity.ts';
import type { operations } from '../tables/cash-in.tables.ts';

export type OperationRow = typeof operations.$inferSelect;

/**
 * Convierte una fila de `operations` en la entidad. La entidad solo copia sus propios campos,
 * así que la columna del lease (detalle del reconciliador) no llega al dominio.
 */
export const toOperation = (row: OperationRow, newBalanceCents: number | null = null): Operation =>
  Operation.restore({ ...row, newBalanceCents });
