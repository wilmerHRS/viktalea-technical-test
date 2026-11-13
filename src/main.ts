import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { logger } from './shared/infrastructure/logging/logger.ts';

// Every feature module is created here and handed to the app.
// To add a new module: create it and add it to this list.
const app = createApp([]);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Server listening');
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
