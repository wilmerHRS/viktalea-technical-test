import { sql } from 'drizzle-orm';

/**
 * Hora actual del servidor de base de datos (no la del pod, para que todos usen el mismo reloj).
 */
export const NOW = sql`now()`;

/** Instante de hace `ms` milisegundos, calculado en la base de datos. */
export const millisecondsAgo = (ms: number) => sql`now() - ${ms} * interval '1 millisecond'`;

/** Instante dentro de `ms` milisegundos, calculado en la base de datos. */
export const millisecondsFromNow = (ms: number) => sql`now() + ${ms} * interval '1 millisecond'`;
