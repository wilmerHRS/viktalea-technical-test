/** Códigos de Node para "no se pudo conectar con el servidor". */
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']);

/**
 * SQLSTATE de PostgreSQL que indican que la BD no está disponible (no que la consulta esté mal).
 */
const UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // el administrador terminó la conexión (reinicio)
  '57P02', // caída del servidor
  '57P03', // la BD aún no acepta conexiones (arrancando)
]);
const CONNECTION_EXCEPTION_PREFIX = '08'; // clase 08: errores de conexión

/**
 * Mensajes de `pg` que no traen código pero significan "se perdió la conexión":
 * - el pool no consigue una conexión a tiempo;
 * - la BD se cae con conexiones ya abiertas en el pool (detectado en la validación en vivo:
 *   sin esto, una caída con el pool "caliente" respondía 500 en vez de 503).
 */
const CONNECTION_LOST_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
];

const MAX_CAUSE_DEPTH = 5;

const readCode = (error: object): string | undefined =>
  'code' in error && typeof error.code === 'string' ? error.code : undefined;

const isUnavailable = (error: object): boolean => {
  const code = readCode(error);
  const message = error instanceof Error ? error.message : '';
  return (
    (code !== undefined && NETWORK_ERROR_CODES.has(code)) ||
    (code !== undefined && UNAVAILABLE_SQLSTATES.has(code)) ||
    (code !== undefined && code.startsWith(CONNECTION_EXCEPTION_PREFIX)) ||
    CONNECTION_LOST_MESSAGES.some((lostMessage) => message.includes(lostMessage))
  );
};

/**
 * true si el error significa "la base de datos no está disponible" (R8.1), recorriendo la
 * cadena de `cause` porque Drizzle envuelve el error original de `pg`.
 */
export const isDatabaseUnavailableError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if (isUnavailable(current)) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
};
