import test from 'node:test';
import assert from 'node:assert/strict';

import { mt5, brokeret } from '../src/config/connectors.js';
import {
  CLIENT_FIXTURES,
  MockMT5Connector,
  MockBrokeretConnector,
  RealMT5Connector,
  RealBrokeretConnector,
  TtlCache,
  instrument,
  withRetry,
  defaultIsRetryable,
  type RetryPolicy,
  type MT5Connector,
} from '../src/connectors/index.js';
import { NotImplementedError } from '../src/lib/errors.js';

const WIDE_RANGE = { from: '2000-01-01', to: '2100-12-31' } as const;

const policy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1,
  maxDelayMs: 4,
  factor: 2,
  isRetryable: defaultIsRetryable,
};

test('mock connectors return correct shapes for every fixture client', async () => {
  const mockMt5 = new MockMT5Connector();
  const mockBrokeret = new MockBrokeretConnector();

  for (const fixture of CLIENT_FIXTURES) {
    const client = await mockBrokeret.getClient(fixture.crmClientId);
    assert.equal(client.name, fixture.client.name);
    assert.deepEqual(client.mt5Logins, fixture.client.mt5Logins);
    assert.equal(typeof client.consentAiMessaging, 'boolean');
    assert.ok(['bronze', 'silver', 'gold', 'platinum'].includes(client.accountTier));

    for (const login of fixture.client.mt5Logins) {
      const summary = await mockMt5.getAccountSummary(login);
      assert.equal(summary.login, login);
      for (const k of ['balance', 'equity', 'margin', 'openPnL'] as const) {
        assert.equal(typeof summary[k], 'number', `${login}.${k} is a number`);
      }

      const closed = await mockMt5.getClosedTrades(login, WIDE_RANGE.from, WIDE_RANGE.to);
      assert.ok(Array.isArray(closed));
      for (const t of closed) {
        assert.ok(['buy', 'sell'].includes(t.direction));
        for (const k of ['volume', 'profit', 'swap', 'commission'] as const) {
          assert.equal(typeof t[k], 'number');
        }
        assert.match(t.openTime, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(t.closeTime, /^\d{4}-\d{2}-\d{2}T/);
      }

      const open = await mockMt5.getOpenPositions(login);
      assert.ok(Array.isArray(open));
    }
  }
});

test('fixtures cover the documented personas', async () => {
  const m = new MockMT5Connector();
  // winning: all closed positive
  const win = await m.getClosedTrades(500001, WIDE_RANGE.from, WIDE_RANGE.to);
  assert.ok(win.length > 0 && win.every((t) => t.profit > 0));
  // losing: all closed negative
  const lose = await m.getClosedTrades(500002, WIDE_RANGE.from, WIDE_RANGE.to);
  assert.ok(lose.length > 0 && lose.every((t) => t.profit < 0));
  // weekend-holder: Friday-opened open position with large swap
  const weekend = await m.getOpenPositions(500003);
  assert.ok(weekend.some((p) => p.openTime.startsWith('2025-06-20') && p.swap <= -30));
  // zero trades
  assert.equal((await m.getClosedTrades(500004, WIDE_RANGE.from, WIDE_RANGE.to)).length, 0);
  assert.equal((await m.getOpenPositions(500004)).length, 0);
  // only open positions
  assert.equal((await m.getClosedTrades(500005, WIDE_RANGE.from, WIDE_RANGE.to)).length, 0);
  assert.ok((await m.getOpenPositions(500005)).length > 0);
});

test('factory respects USE_MOCK_CONNECTORS (mock active in tests)', async () => {
  // The wired singletons run mocks (USE_MOCK_CONNECTORS=true in test.env).
  const summary = await mt5.getAccountSummary(500001);
  assert.equal(summary.login, 500001);
  const page = await brokeret.listActiveClients(1, 10);
  assert.ok(page.total >= 1);
});

test('real stubs throw "awaiting API docs" (the USE_MOCK_CONNECTORS=false result)', async () => {
  const realMt5 = new RealMT5Connector();
  const realBrokeret = new RealBrokeretConnector();
  const isAwaiting = (e: unknown) =>
    e instanceof NotImplementedError && /awaiting API docs/.test((e as Error).message);

  await assert.rejects(() => realMt5.getAccountSummary(1), isAwaiting);
  await assert.rejects(() => realMt5.getClosedTrades(1, '2025-01-01', '2025-01-02'), isAwaiting);
  await assert.rejects(() => realMt5.getOpenPositions(1), isAwaiting);
  await assert.rejects(() => realBrokeret.getClient('crm-1001'), isAwaiting);
  await assert.rejects(() => realBrokeret.listActiveClients(1, 10), isAwaiting);
});

test('retry wrapper retries transient errors then succeeds', async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('transient');
    return 'ok';
  }, policy);
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('retry wrapper does not retry non-retryable errors', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        attempts += 1;
        throw new NotImplementedError('nope');
      }, policy),
    NotImplementedError,
  );
  assert.equal(attempts, 1);
});

test('cache wrapper serves repeat reads from cache within TTL', async () => {
  let calls = 0;
  const counting: MT5Connector = {
    async getAccountSummary(login) {
      calls += 1;
      return { login, balance: 1, equity: 1, margin: 0, openPnL: 0, currency: 'USD' };
    },
    async getClosedTrades() {
      return [];
    },
    async getOpenPositions() {
      return [];
    },
  };
  const cache = new TtlCache();
  const wrapped = instrument(counting, {
    name: 'test',
    retry: policy,
    cache,
    defaultTtlMs: 10_000,
  });

  await wrapped.getAccountSummary(1);
  await wrapped.getAccountSummary(1);
  assert.equal(calls, 1, 'same key served from cache');

  await wrapped.getAccountSummary(2);
  assert.equal(calls, 2, 'different key bypasses cache');

  cache.invalidate();
  await wrapped.getAccountSummary(1);
  assert.equal(calls, 3, 'invalidated key reloads');
});
