/**
 * Public connector surface. Business logic should import the *types* and the
 * wired singletons from `config/connectors.ts` — the concrete mock/real classes
 * here are exported mainly for tests and the factory.
 */

// Interfaces + domain types
export type {
  AccountSummary,
  ClosedTrade,
  MT5Connector,
  OpenPosition,
  TradeDirection,
} from './mt5/types.js';
export type {
  AccountTier,
  BrokeretConnector,
  ClientListEntry,
  CrmClient,
  KycStatus,
  PaginatedClients,
} from './brokeret/types.js';

// Implementations
export { MockMT5Connector } from './mt5/mock.js';
export { RealMT5Connector } from './mt5/real.js';
export { MockBrokeretConnector } from './brokeret/mock.js';
export { RealBrokeretConnector } from './brokeret/real.js';

// Wrapper layer
export { TtlCache } from './cache.js';
export { withRetry, defaultIsRetryable, type RetryPolicy } from './retry.js';
export { instrument, type InstrumentOptions } from './instrument.js';

// Fixtures (for tests / seeding)
export {
  CLIENT_FIXTURES,
  FIXTURES_BY_CLIENT_ID,
  FIXTURE_ACCOUNTS_BY_LOGIN,
  type ClientFixture,
  type Mt5AccountFixture,
} from './fixtures.js';
