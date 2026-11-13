/** true si el error es de express.json() al recibir un body que no es JSON válido. */
export const isJsonParseError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed';
