import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  AccountSummary,
  ClosedTrade,
  OpenPosition,
} from '../src/connectors/mt5/types.js';
import { MockMT5Connector, MockBrokeretConnector, CLIENT_FIXTURES } from '../src/connectors/index.js';
import {
  computeClientMetrics,
  gatherMetricsInput,
  netProfit,
  type ClientMetrics,
  type Granularity,
  type MetricsInput,
  type WindowData,
} from '../src/metrics/index.js';

// ── Builders ─────────────────────────────────────────────────────────────────
let seq = 1;
function trade(
  p: Partial<ClosedTrade> & { profit: number; openTime: string; closeTime: string },
): ClosedTrade {
  return {
    ticket: p.ticket ?? seq++,
    symbol: p.symbol ?? 'EURUSD',
    direction: p.direction ?? 'buy',
    volume: p.volume ?? 1,
    openTime: p.openTime,
    closeTime: p.closeTime,
    openPrice: p.openPrice ?? 1.1,
    closePrice: p.closePrice ?? 1.1,
    profit: p.profit,
    swap: p.swap ?? 0,
    commission: p.commission ?? 0,
  };
}

function position(p: Partial<OpenPosition> & { openTime: string }): OpenPosition {
  return {
    ticket: p.ticket ?? seq++,
    symbol: p.symbol ?? 'EURUSD',
    direction: p.direction ?? 'buy',
    volume: p.volume ?? 1,
    openTime: p.openTime,
    openPrice: p.openPrice ?? 1.1,
    currentPrice: p.currentPrice ?? 1.1,
    unrealizedPnL: p.unrealizedPnL ?? 0,
    swap: p.swap ?? 0,
  };
}

function account(o: Partial<AccountSummary> = {}): AccountSummary {
  return {
    login: o.login ?? 1,
    balance: o.balance ?? 10_000,
    equity: o.equity ?? 10_000,
    margin: o.margin ?? 0,
    openPnL: o.openPnL ?? 0,
    currency: o.currency ?? 'USD',
    ...o,
  };
}

function windowData(
  closedTrades: ClosedTrade[],
  openPositions: OpenPosition[] = [],
  acct: AccountSummary = account(),
  opts: { granularity?: Granularity; from?: string; to?: string; asOf?: string } = {},
): WindowData {
  return {
    window: {
      granularity: opts.granularity ?? 'weekly',
      from: opts.from ?? '2025-06-16',
      to: opts.to ?? '2025-06-22',
    },
    account: acct,
    closedTrades,
    openPositions,
    asOf: opts.asOf ?? '2025-06-22T23:59:59.999Z',
  };
}

function input(current: WindowData, prior?: WindowData): MetricsInput {
  return prior
    ? { crmClientId: 'crm-test', current, prior }
    : { crmClientId: 'crm-test', current };
}

const FORWARD_LOOKING = /\b(will|expect|forecast|predict|should|going to|likely|tomorrow|next (week|day)|future|recommend|buy now|sell now)\b/i;

function assertFactual(m: ClientMetrics): void {
  for (const o of m.behavioralObservations) {
    assert.equal(typeof o, 'string');
    assert.ok(o.length > 0);
    assert.ok(!FORWARD_LOOKING.test(o), `observation must be factual, not forward-looking: "${o}"`);
  }
}

function assertComplete(m: ClientMetrics): void {
  for (const k of ['numTrades', 'wins', 'losses', 'winRate', 'totalPnL', 'grossProfit', 'grossLoss'] as const) {
    assert.equal(typeof m[k], 'number');
    assert.ok(Number.isFinite(m[k]));
  }
  assert.ok(m.drawdown && typeof m.drawdown.maxDrawdown === 'number');
  assert.ok(m.openRisk && typeof m.openRisk.marginUtilization === 'number');
  assert.ok(m.flags && typeof m.flags.weekendHolding === 'boolean');
  assert.ok(Array.isArray(m.mostTradedSymbols));
  assert.ok(Array.isArray(m.behavioralObservations));
  assert.ok(typeof m.display.winRate === 'string');
  assertFactual(m);
}

// ── Edge cases ───────────────────────────────────────────────────────────────
test('zero trades', () => {
  const m = computeClientMetrics(input(windowData([], [])));
  assert.equal(m.numTrades, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.bestTrade, null);
  assert.equal(m.worstTrade, null);
  assert.equal(m.averageHoldMs, null);
  assert.equal(m.drawdown.maxDrawdown, 0);
  assert.equal(m.flags.weekendHolding, false);
  assert.equal(m.flags.revengeTrading, false);
  assert.equal(m.display.winRate, 'N/A');
  assert.ok(m.behavioralObservations.some((o) => /no closed trades/i.test(o)));
  assertComplete(m);
});

test('all wins', () => {
  const trades = [
    trade({ profit: 100, symbol: 'EURUSD', openTime: '2025-06-16T08:00:00Z', closeTime: '2025-06-16T12:00:00Z' }),
    trade({ profit: 250, symbol: 'XAUUSD', openTime: '2025-06-17T08:00:00Z', closeTime: '2025-06-17T18:00:00Z' }),
    trade({ profit: 75, symbol: 'EURUSD', openTime: '2025-06-18T08:00:00Z', closeTime: '2025-06-18T10:00:00Z' }),
  ];
  const m = computeClientMetrics(input(windowData(trades)));
  assert.equal(m.wins, 3);
  assert.equal(m.losses, 0);
  assert.equal(m.winRate, 1);
  assert.equal(m.grossLoss, 0);
  assert.equal(m.totalPnL, 425);
  assert.equal(m.bestTrade?.netProfit, 250);
  assert.equal(m.worstTrade?.netProfit, 75); // least-good winner
  assert.equal(m.drawdown.maxDrawdown, 0, 'monotonic-up curve has no drawdown');
  assert.ok(m.behavioralObservations.some((o) => o.includes('100.0% win rate') || o.includes('100% win rate')));
  assertComplete(m);
});

test('all losses', () => {
  const trades = [
    trade({ profit: -100, openTime: '2025-06-16T08:00:00Z', closeTime: '2025-06-16T09:00:00Z' }),
    trade({ profit: -200, openTime: '2025-06-17T08:00:00Z', closeTime: '2025-06-17T09:00:00Z' }),
    trade({ profit: -50, openTime: '2025-06-18T08:00:00Z', closeTime: '2025-06-18T09:00:00Z' }),
  ];
  const m = computeClientMetrics(input(windowData(trades, [], account({ balance: 10_000 }))));
  assert.equal(m.wins, 0);
  assert.equal(m.losses, 3);
  assert.equal(m.winRate, 0);
  assert.equal(m.grossProfit, 0);
  assert.equal(m.totalPnL, -350);
  assert.equal(m.bestTrade?.netProfit, -50); // least-bad loss
  assert.equal(m.worstTrade?.netProfit, -200);
  assert.equal(m.drawdown.maxDrawdown, 350, 'monotonic-down curve drawdown = total loss');
  assert.equal(m.drawdown.maxDrawdownPct, 0.035); // 350 / 10,000
  assertComplete(m);
});

test('single trade', () => {
  const m = computeClientMetrics(
    input(windowData([trade({ profit: 120, symbol: 'GBPUSD', openTime: '2025-06-17T08:00:00Z', closeTime: '2025-06-17T11:00:00Z' })])),
  );
  assert.equal(m.numTrades, 1);
  assert.equal(m.bestTrade?.ticket, m.worstTrade?.ticket);
  assert.equal(m.averageHoldMs, 3 * 3_600_000);
  assert.ok(m.behavioralObservations.some((o) => /only trade returned/i.test(o)));
  assertComplete(m);
});

test('open positions but no closed trades', () => {
  const open = [
    position({ symbol: 'EURUSD', volume: 1, unrealizedPnL: 200, openTime: '2025-06-23T09:00:00Z' }),
    position({ symbol: 'XAUUSD', volume: 0.5, unrealizedPnL: -50, openTime: '2025-06-23T10:00:00Z' }),
  ];
  const m = computeClientMetrics(
    input(windowData([], open, account({ margin: 1_500, equity: 12_000, openPnL: 150 }), { asOf: '2025-06-24T12:00:00Z' })),
  );
  assert.equal(m.numTrades, 0);
  assert.equal(m.openRisk.openPositions, 2);
  assert.equal(m.openRisk.openPnL, 150);
  assert.ok(m.exposureConcentration > 0);
  assert.ok(m.behavioralObservations.some((o) => /open exposure/i.test(o)));
  assertComplete(m);
});

test('weekend holder flags weekend holding', () => {
  // Opened Friday 2025-06-20, closed Monday 2025-06-23 → spans the weekend.
  const trades = [
    trade({ profit: -300, symbol: 'XAUUSD', openTime: '2025-06-20T15:00:00Z', closeTime: '2025-06-23T09:00:00Z' }),
    trade({ profit: 100, symbol: 'EURUSD', openTime: '2025-06-18T08:00:00Z', closeTime: '2025-06-18T12:00:00Z' }),
  ];
  const m = computeClientMetrics(input(windowData(trades)));
  assert.equal(m.flags.weekendHolding, true);
  assert.ok(m.flagEvidence.weekendHeldTrades >= 1);
  assert.ok(m.flagEvidence.weekendLossShare > 0);
  assert.ok(
    m.behavioralObservations.some((o) => /of your losses came from positions held over the weekend/i.test(o)),
  );
  assertComplete(m);

  // Also via an open position held across the weekend up to asOf.
  const m2 = computeClientMetrics(
    input(windowData([], [position({ openTime: '2025-06-20T16:00:00Z', volume: 1, unrealizedPnL: -10 })], account({ margin: 100 }), { asOf: '2025-06-23T08:00:00Z' })),
  );
  assert.equal(m2.flags.weekendHolding, true);
});

test('revenge-trading pattern flagged', () => {
  // A loss closes at 10:00; two new trades open within 30 min.
  const trades = [
    trade({ profit: -150, openTime: '2025-06-17T08:00:00Z', closeTime: '2025-06-17T10:00:00Z' }),
    trade({ profit: 40, openTime: '2025-06-17T10:05:00Z', closeTime: '2025-06-17T10:40:00Z' }),
    trade({ profit: -20, openTime: '2025-06-17T10:20:00Z', closeTime: '2025-06-17T11:00:00Z' }),
  ];
  const m = computeClientMetrics(input(windowData(trades)));
  assert.equal(m.flags.revengeTrading, true);
  assert.equal(m.flagEvidence.revengeTrades, 2);
  assert.ok(m.behavioralObservations.some((o) => /within 30 minutes of closing a loss/i.test(o)));
  assertComplete(m);
});

test('clustering of trades in short bursts flagged', () => {
  const trades = [
    trade({ profit: 10, openTime: '2025-06-17T09:00:00Z', closeTime: '2025-06-17T09:05:00Z' }),
    trade({ profit: 10, openTime: '2025-06-17T09:03:00Z', closeTime: '2025-06-17T09:06:00Z' }),
    trade({ profit: 10, openTime: '2025-06-17T09:07:00Z', closeTime: '2025-06-17T09:10:00Z' }),
  ];
  const m = computeClientMetrics(input(windowData(trades)));
  assert.equal(m.flags.tradeClustering, true);
  assert.ok(m.flagEvidence.largestBurst >= 3);
  assertComplete(m);
});

test('overleveraging flagged from margin/equity', () => {
  const m = computeClientMetrics(
    input(windowData([], [], account({ margin: 7_000, equity: 10_000 }))),
  );
  assert.equal(m.flags.overleveraging, true);
  assert.ok(m.behavioralObservations.some((o) => /open margin uses/i.test(o)));
});

test('week-over-week deltas with and without a prior window', () => {
  const cur = windowData([
    trade({ profit: 100, openTime: '2025-06-16T08:00:00Z', closeTime: '2025-06-16T10:00:00Z' }),
    trade({ profit: 200, openTime: '2025-06-17T08:00:00Z', closeTime: '2025-06-17T10:00:00Z' }),
  ]);
  const prior = windowData(
    [trade({ profit: -50, openTime: '2025-06-09T08:00:00Z', closeTime: '2025-06-09T10:00:00Z' })],
    [],
    account(),
    { from: '2025-06-09', to: '2025-06-15' },
  );

  const withPrior = computeClientMetrics(input(cur, prior));
  assert.ok(withPrior.deltas);
  assert.equal(withPrior.deltas?.numTrades, 1); // 2 - 1
  assert.equal(withPrior.deltas?.totalPnL, 350); // 300 - (-50)
  assert.equal(withPrior.deltas?.winRate, 1); // 1.0 - 0.0
  assert.ok(withPrior.behavioralObservations.some((o) => /Compared with the prior week/i.test(o)));

  const withoutPrior = computeClientMetrics(input(cur));
  assert.equal(withoutPrior.deltas, null);
  assert.ok(!withoutPrior.behavioralObservations.some((o) => /prior week/i.test(o)));
});

// ── Integration: every mock fixture client yields a complete object ──────────
test('every mock fixture client emits a complete, correct ClientMetrics', async () => {
  const conns = { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() };
  for (const fixture of CLIENT_FIXTURES) {
    const inp = await gatherMetricsInput(conns, {
      crmClientId: fixture.crmClientId,
      granularity: 'weekly',
      referenceDate: '2025-06-25',
      includePrior: true,
    });
    const m = computeClientMetrics(inp);
    assert.equal(m.crmClientId, fixture.crmClientId);
    assertComplete(m);
    // P&L must equal the sum of net profits of the windowed closed trades.
    const expected = inp.current.closedTrades.reduce((a, t) => a + netProfit(t), 0);
    assert.ok(Math.abs(m.totalPnL - expected) < 0.01);
  }
});

test('fixture sanity: winning client net positive, weekend-holder flagged', async () => {
  const conns = { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() };

  const winning = computeClientMetrics(
    await gatherMetricsInput(conns, { crmClientId: 'crm-1001', granularity: 'weekly', referenceDate: '2025-06-22' }),
  );
  assert.ok(winning.totalPnL > 0);

  const weekend = computeClientMetrics(
    await gatherMetricsInput(conns, {
      crmClientId: 'crm-1003',
      granularity: 'weekly',
      referenceDate: '2025-06-25',
      asOf: '2025-06-25T12:00:00Z',
    }),
  );
  assert.equal(weekend.flags.weekendHolding, true);
});
