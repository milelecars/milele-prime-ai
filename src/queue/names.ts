/**
 * Canonical queue names — side-effect-free so they can be imported without
 * constructing BullMQ queues (which would eagerly connect to Redis).
 */
export const QUEUE_NAMES = {
  OUTBOUND: 'outbound',
  METRICS: 'metrics',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
