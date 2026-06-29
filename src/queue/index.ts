import { Queue } from 'bullmq';
import { childLogger } from '../lib/logger.js';
import { redisConnection } from './connection.js';
import { QUEUE_NAMES } from './names.js';

const log = childLogger('queue');

export { QUEUE_NAMES, type QueueName } from './names.js';

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Queue for outbound messaging jobs (daily reports, marketing). */
export const outboundQueue = new Queue(QUEUE_NAMES.OUTBOUND, {
  connection: redisConnection,
  defaultJobOptions,
});

/** Queue for metrics-computation jobs. */
export const metricsQueue = new Queue(QUEUE_NAMES.METRICS, {
  connection: redisConnection,
  defaultJobOptions,
});

log.debug('Queues initialised');

/** Gracefully close all queue connections (used during shutdown). */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([outboundQueue.close(), metricsQueue.close()]);
  log.info('Queues closed');
}
