import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { createUsersModule } from './modules/users/index.ts';

// Every feature module is created here and handed to the app.
// To add a new module: create it and add it to this list.
const app = createApp([
  createUsersModule(), // → /api/v1/users
]);

const server = app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
