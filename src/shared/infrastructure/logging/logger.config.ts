import { pino } from 'pino';
import { env } from '../../../config/env.config.ts';

export const logger = pino({ level: env.LOG_LEVEL });
