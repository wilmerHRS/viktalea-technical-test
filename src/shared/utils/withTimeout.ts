/**
 * Espera `promise` como máximo `timeoutMs`. Si se agota el tiempo, lanza el error que devuelve
 * `onTimeout()`. La promesa original NO se cancela: solo dejamos de esperarla.
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
