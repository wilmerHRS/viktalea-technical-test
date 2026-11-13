import { Operation } from '../../domain/entities/Operation.ts';
import type { operations } from './schema.ts';

export type OperationRow = typeof operations.$inferSelect;

/**
 * Convierte una fila de `operations` en la entidad. La entidad solo copia sus propios campos,
 * así que la columna del lease (detalle del reconciliador) no llega al dominio.
 */
export const toOperation = (row: OperationRow, newBalanceCents: number | null = null): Operation =>
  Operation.restore({ ...row, newBalanceCents });
