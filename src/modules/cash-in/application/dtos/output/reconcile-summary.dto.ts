/** Qué pasó en un ciclo de reconciliación (para logs y tests). */
export interface ReconcileSummary {
  reserved: number;
  completed: number;
  failed: number;
  stillPending: number;
  errors: number;
}
