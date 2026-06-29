import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('queue:connection');

/**
 * Shared ioredis connection for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
 * blocking commands (workers). We reuse a single connection for queues.
 */
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  // Back off reconnect attempts so an unavailable Redis doesn't flood logs.
  retryStrategy: (attempts) => Math.min(attempts * 1_000, 30_000),
});

// Log connection errors at most once per ~30s to avoid log spam when Redis is
// unreachable (the retryStrategy keeps trying in the background).
let lastErrorLoggedAt = 0;
redisConnection.on('error', (err) => {
  const now = Date.now();
  if (now - lastErrorLoggedAt > 30_000) {
    lastErrorLoggedAt = now;
    log.error({ err: { code: (err as { code?: string }).code, message: err.message } }, 'Redis connection error');
  }
});
redisConnection.on('connect', () => log.info('Redis connected'));
