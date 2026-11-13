import type { Logger } from 'pino';
import type { ReconcileOperations } from '../../application/use-cases/reconcile-operations.use-case.ts';

export interface ReconcilerJobDependencies {
  reconcileOperations: Pick<ReconcileOperations, 'execute'>;
  intervalMs: number;
  logger: Logger;
}

export interface ReconcilerJob {
  /** Detiene el intervalo. Un ciclo en curso termina normalmente. */
  stop(): void;
}

/**
 * Ejecuta la reconciliación al arrancar (resuelve lo que quedó a medias por un reinicio, R8.2)
 * y después cada `intervalMs` (R7.1). Nunca solapa dos ciclos en el mismo pod.
 */
export const startReconcilerJob = ({
  reconcileOperations,
  intervalMs,
  logger,
}: ReconcilerJobDependencies): ReconcilerJob => {
  let isRunning = false;

  const runCycle = async (): Promise<void> => {
    if (isRunning) {
      return;
    }
    isRunning = true;
    try {
      await reconcileOperations.execute();
    } catch (error) {
      // Un fallo (p. ej. la BD caída) no detiene el job: se reintenta en el siguiente ciclo.
      logger.error({ err: error }, 'Reconciliation cycle failed');
    } finally {
      isRunning = false;
    }
  };

  void runCycle();
  const timer = setInterval(() => void runCycle(), intervalMs);
  // No mantener vivo el proceso solo por este intervalo.
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
};
