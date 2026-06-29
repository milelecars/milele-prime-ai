/**
 * Deterministic fixtures shared by the mock MT5 and Brokeret connectors.
 *
 * Five personas exercise the realistic shapes downstream code must handle:
 *   1. crm-1001 — winning trader (net-positive closed trades, profit on open)
 *   2. crm-1002 — losing trader (net-negative closed trades + open)
 *   3. crm-1003 — weekend-holder (positions opened Friday, large swap accrual)
 *   4. crm-1004 — zero trades (flat account, KYC pending)
 *   5. crm-1005 — only open positions (no closed trades yet)
 *
 * All values are hard-coded literals (no randomness, no `Date.now()`), so
 * tests are stable.
 */
import type { AccountSummary, ClosedTrade, OpenPosition } from './mt5/types.js';
import type { CrmClient } from './brokeret/types.js';

export interface Mt5AccountFixture {
  readonly summary: AccountSummary;
  readonly closedTrades: readonly ClosedTrade[];
  readonly openPositions: readonly OpenPosition[];
}

export interface ClientFixture {
  readonly crmClientId: string;
  readonly client: CrmClient;
  /** Keyed by MT5 login. */
  readonly accounts: Readonly<Record<number, Mt5AccountFixture>>;
}

// ── 1. Winning trader ────────────────────────────────────────────────────────
const WINNING: ClientFixture = {
  crmClientId: 'crm-1001',
  client: {
    name: 'Amara Okafor',
    mt5Logins: [500001],
    accountTier: 'gold',
    kycStatus: 'approved',
    timezone: 'Asia/Dubai',
    country: 'AE',
    consentAiMessaging: true,
    consentMarketing: true,
  },
  accounts: {
    500001: {
      summary: {
        login: 500001,
        balance: 25_000,
        equity: 25_840.5,
        margin: 1_200,
        openPnL: 840.5,
        currency: 'USD',
      },
      closedTrades: [
        {
          ticket: 90010001,
          symbol: 'EURUSD',
          direction: 'buy',
          volume: 1.0,
          openTime: '2025-06-16T08:30:00Z',
          closeTime: '2025-06-16T14:05:00Z',
          openPrice: 1.0712,
          closePrice: 1.0744,
          profit: 320.0,
          swap: -2.4,
          commission: -7.0,
        },
        {
          ticket: 90010002,
          symbol: 'XAUUSD',
          direction: 'buy',
          volume: 0.5,
          openTime: '2025-06-17T09:00:00Z',
          closeTime: '2025-06-18T16:45:00Z',
          openPrice: 2_318.4,
          closePrice: 2_330.6,
          profit: 610.25,
          swap: -5.1,
          commission: -6.0,
        },
        {
          ticket: 90010003,
          symbol: 'GBPUSD',
          direction: 'sell',
          volume: 0.75,
          openTime: '2025-06-19T11:15:00Z',
          closeTime: '2025-06-19T17:20:00Z',
          openPrice: 1.272,
          closePrice: 1.27,
          profit: 150.0,
          swap: -1.2,
          commission: -5.25,
        },
      ],
      openPositions: [
        {
          ticket: 90019001,
          symbol: 'XAUUSD',
          direction: 'buy',
          volume: 0.5,
          openTime: '2025-06-23T10:00:00Z',
          openPrice: 2_325.0,
          currentPrice: 2_341.81,
          unrealizedPnL: 840.5,
          swap: -3.0,
        },
      ],
    },
  },
};

// ── 2. Losing trader ─────────────────────────────────────────────────────────
const LOSING: ClientFixture = {
  crmClientId: 'crm-1002',
  client: {
    name: 'Dmitri Volkov',
    mt5Logins: [500002],
    accountTier: 'silver',
    kycStatus: 'approved',
    timezone: 'Europe/London',
    country: 'GB',
    consentAiMessaging: true,
    consentMarketing: false,
  },
  accounts: {
    500002: {
      summary: {
        login: 500002,
        balance: 8_000,
        equity: 7_460.25,
        margin: 900,
        openPnL: -539.75,
        currency: 'USD',
      },
      closedTrades: [
        {
          ticket: 90020001,
          symbol: 'EURUSD',
          direction: 'sell',
          volume: 1.0,
          openTime: '2025-06-16T10:00:00Z',
          closeTime: '2025-06-16T13:30:00Z',
          openPrice: 1.072,
          closePrice: 1.0746,
          profit: -260.0,
          swap: -2.0,
          commission: -7.0,
        },
        {
          ticket: 90020002,
          symbol: 'USDJPY',
          direction: 'buy',
          volume: 0.8,
          openTime: '2025-06-18T07:45:00Z',
          closeTime: '2025-06-18T19:10:00Z',
          openPrice: 157.9,
          closePrice: 157.32,
          profit: -295.5,
          swap: -3.4,
          commission: -5.6,
        },
        {
          ticket: 90020003,
          symbol: 'XAUUSD',
          direction: 'sell',
          volume: 0.3,
          openTime: '2025-06-20T12:00:00Z',
          closeTime: '2025-06-20T15:40:00Z',
          openPrice: 2_332.0,
          closePrice: 2_338.5,
          profit: -195.0,
          swap: -1.1,
          commission: -3.6,
        },
      ],
      openPositions: [
        {
          ticket: 90029001,
          symbol: 'USDJPY',
          direction: 'buy',
          volume: 0.8,
          openTime: '2025-06-24T08:00:00Z',
          openPrice: 158.2,
          currentPrice: 157.52,
          unrealizedPnL: -539.75,
          swap: -4.2,
        },
      ],
    },
  },
};

// ── 3. Weekend-holder ────────────────────────────────────────────────────────
// Positions opened Friday 2025-06-20 and still open — large negative swap from
// rolling over the weekend.
const WEEKEND_HOLDER: ClientFixture = {
  crmClientId: 'crm-1003',
  client: {
    name: 'Sofia Marchetti',
    mt5Logins: [500003],
    accountTier: 'platinum',
    kycStatus: 'approved',
    timezone: 'Asia/Singapore',
    country: 'SG',
    consentAiMessaging: true,
    consentMarketing: true,
  },
  accounts: {
    500003: {
      summary: {
        login: 500003,
        balance: 50_000,
        equity: 49_200.0,
        margin: 5_000,
        openPnL: -800.0,
        currency: 'USD',
      },
      closedTrades: [
        {
          ticket: 90030001,
          symbol: 'EURUSD',
          direction: 'buy',
          volume: 2.0,
          openTime: '2025-06-17T09:00:00Z',
          closeTime: '2025-06-18T12:00:00Z',
          openPrice: 1.0705,
          closePrice: 1.0731,
          profit: 520.0,
          swap: -8.0,
          commission: -14.0,
        },
      ],
      openPositions: [
        {
          ticket: 90039001,
          symbol: 'XAUUSD',
          direction: 'buy',
          volume: 1.5,
          openTime: '2025-06-20T15:30:00Z',
          openPrice: 2_336.0,
          currentPrice: 2_333.6,
          unrealizedPnL: -360.0,
          swap: -48.0,
        },
        {
          ticket: 90039002,
          symbol: 'GBPUSD',
          direction: 'sell',
          volume: 1.0,
          openTime: '2025-06-20T16:10:00Z',
          openPrice: 1.268,
          currentPrice: 1.2704,
          unrealizedPnL: -440.0,
          swap: -32.0,
        },
      ],
    },
  },
};

// ── 4. Zero trades ───────────────────────────────────────────────────────────
const ZERO_TRADES: ClientFixture = {
  crmClientId: 'crm-1004',
  client: {
    name: 'Liang Chen',
    mt5Logins: [500004],
    accountTier: 'bronze',
    kycStatus: 'pending',
    timezone: 'America/New_York',
    country: 'US',
    consentAiMessaging: false,
    consentMarketing: false,
  },
  accounts: {
    500004: {
      summary: {
        login: 500004,
        balance: 1_000,
        equity: 1_000,
        margin: 0,
        openPnL: 0,
        currency: 'USD',
      },
      closedTrades: [],
      openPositions: [],
    },
  },
};

// ── 5. Only open positions ───────────────────────────────────────────────────
const ONLY_OPEN: ClientFixture = {
  crmClientId: 'crm-1005',
  client: {
    name: 'Fatima Al-Sayed',
    mt5Logins: [500005],
    accountTier: 'silver',
    kycStatus: 'approved',
    timezone: 'Europe/Berlin',
    country: 'DE',
    consentAiMessaging: true,
    consentMarketing: false,
  },
  accounts: {
    500005: {
      summary: {
        login: 500005,
        balance: 12_000,
        equity: 12_350.0,
        margin: 1_500,
        openPnL: 350.0,
        currency: 'USD',
      },
      closedTrades: [],
      openPositions: [
        {
          ticket: 90059001,
          symbol: 'EURUSD',
          direction: 'buy',
          volume: 1.0,
          openTime: '2025-06-25T09:30:00Z',
          openPrice: 1.0738,
          currentPrice: 1.0758,
          unrealizedPnL: 200.0,
          swap: -1.5,
        },
        {
          ticket: 90059002,
          symbol: 'XAUUSD',
          direction: 'buy',
          volume: 0.2,
          openTime: '2025-06-25T11:00:00Z',
          openPrice: 2_340.0,
          currentPrice: 2_347.5,
          unrealizedPnL: 150.0,
          swap: -0.8,
        },
      ],
    },
  },
};

export const CLIENT_FIXTURES: readonly ClientFixture[] = [
  WINNING,
  LOSING,
  WEEKEND_HOLDER,
  ZERO_TRADES,
  ONLY_OPEN,
];

/** Index: crmClientId → fixture. */
export const FIXTURES_BY_CLIENT_ID: ReadonlyMap<string, ClientFixture> = new Map(
  CLIENT_FIXTURES.map((f) => [f.crmClientId, f]),
);

/** Index: MT5 login → account fixture. */
export const FIXTURE_ACCOUNTS_BY_LOGIN: ReadonlyMap<number, Mt5AccountFixture> = new Map(
  CLIENT_FIXTURES.flatMap((f) =>
    Object.entries(f.accounts).map(([login, account]) => [Number(login), account] as const),
  ),
);
