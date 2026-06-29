import { pino } from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Structured application logger.
 *
 * - In production: line-delimited JSON (ready for log aggregation).
 * - In development: pretty-printed, colourised output via `pino-pretty`.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'milele-prime-ai' },
  redact: {
    paths: [
      'req.headers.authorization',
      '*.TELEGRAM_BOT_TOKEN',
      '*.SUPABASE_SERVICE_KEY',
      '*.MT5_API_KEY',
      '*.BROKERET_API_KEY',
      '*.LLM_API_KEY',
      '*.ELEVENLABS_API_KEY',
      '*.IDENTITY_SIGNING_SECRET',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

/** Create a child logger bound to a sub-component (e.g. `bot`, `queue`). */
export function childLogger(component: string): typeof logger {
  return logger.child({ component });
}
