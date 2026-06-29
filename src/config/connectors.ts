/**
 * Connector factory.
 *
 * Selects mock vs real implementations via `USE_MOCK_CONNECTORS`, then wraps
 * the chosen implementation with retry-with-backoff + a short-TTL cache. All
 * downstream code depends only on the {@link MT5Connector} / {@link
 * BrokeretConnector} interfaces — never on a concrete class.
 */
import { childLogger } from '../lib/logger.js';
import { TtlCache } from '../connectors/cache.js';
import { defaultIsRetryable, type RetryPolicy } from '../connectors/retry.js';
import { instrument } from '../connectors/instrument.js';
import { MockMT5Connector } from '../connectors/mt5/mock.js';
import { RealMT5Connector } from '../connectors/mt5/real.js';
import { MockBrokeretConnector } from '../connectors/brokeret/mock.js';
import { RealBrokeretConnector } from '../connectors/brokeret/real.js';
import type { MT5Connector } from '../connectors/mt5/types.js';
import type { BrokeretConnector } from '../connectors/brokeret/types.js';
import { env } from './env.js';

const log = childLogger('connectors');

const retryPolicy: RetryPolicy = {
  maxAttempts: env.CONNECTOR_MAX_RETRIES,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  factor: 2,
  isRetryable: defaultIsRetryable,
};

// One shared cache across connectors; keys are namespaced per connector.
const cache = new TtlCache();

/** Build the active MT5 connector (mock or real), wrapped with retry + cache. */
export function createMT5Connector(): MT5Connector {
  const base: MT5Connector = env.USE_MOCK_CONNECTORS
    ? new MockMT5Connector()
    : new RealMT5Connector();
  return instrument(base, {
    name: 'mt5',
    retry: retryPolicy,
    cache,
    defaultTtlMs: env.CONNECTOR_CACHE_TTL_MS,
  });
}

/** Build the active Brokeret connector (mock or real), wrapped with retry + cache. */
export function createBrokeretConnector(): BrokeretConnector {
  const base: BrokeretConnector = env.USE_MOCK_CONNECTORS
    ? new MockBrokeretConnector()
    : new RealBrokeretConnector();
  return instrument(base, {
    name: 'brokeret',
    retry: retryPolicy,
    cache,
    defaultTtlMs: env.CONNECTOR_CACHE_TTL_MS,
  });
}

log.info(
  { mode: env.USE_MOCK_CONNECTORS ? 'mock' : 'real', cacheTtlMs: env.CONNECTOR_CACHE_TTL_MS },
  'Connectors initialised',
);

/** Wired, ready-to-use connector singletons. Import these from business logic. */
export const mt5: MT5Connector = createMT5Connector();
export const brokeret: BrokeretConnector = createBrokeretConnector();
