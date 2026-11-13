/** Configuración del reconciliador (sale de las variables de entorno). */
export interface ReconcileSettings {
  /** Antigüedad a partir de la cual una operación en PROCESSING se considera atascada. */
  staleAfterMs: number;
  /** Duración de la reserva de cada operación. */
  leaseMs: number;
  /** Tiempo máximo de espera por cada consulta a la pasarela. */
  providerTimeoutMs: number;
}
