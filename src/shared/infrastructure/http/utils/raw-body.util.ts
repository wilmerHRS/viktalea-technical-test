import type { IncomingMessage } from 'node:http';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Bytes exactos del body: la firma HMAC de un webhook se calcula sobre ellos, no sobre el JSON.
     */
    rawBody?: Buffer;
  }
}

/** Opción `verify` de express.json(): guarda el body crudo antes de parsearlo. */
export const captureRawBody = (req: IncomingMessage, _res: unknown, buffer: Buffer): void => {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buffer;
};
