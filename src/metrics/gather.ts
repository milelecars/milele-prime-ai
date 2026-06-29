/**
 * I/O boundary for the metrics layer: fetch raw data from the connectors and
 * assemble a {@link MetricsInput}. This is the ONLY part that performs I/O —
 * the math in `compute.ts` stays pure over the result.
 */
import type { BrokeretConnector } from '../connectors/brokeret/types.js';
import type { AccountSummary, MT5Connector } from '../connectors/mt5/types.js';
import type { Granularity, MetricsInput, MetricsWindow, WindowData } from './types.js';

export interface MetricsConnectors {
  readonly mt5: MT5Connector;
  readonly brokeret: BrokeretConnector;
}

export interface GatherParams {
  readonly crmClientId: string;
  readonly granularity: Granularity;
  /** End date of the current window (inclusive), `YYYY-MM-DD`. */
  readonly referenceDate: string;
  /** Reference instant for open-position holds. Defaults to end of referenceDate. */
  readonly asOf?: string;
  /** Also gather the immediately-preceding window for week-over-week deltas. */
  readonly includePrior?: boolean;
}

const DAY_MS = 86_400_000;

function addDays(isoDate: string, days: number): string {
  const t = new Date(`${isoDate}T00:00:00.000Z`).getTime() + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function windowFor(granularity: Granularity, endDate: string): MetricsWindow {
  const span = granularity === 'weekly' ? 6 : 0; // inclusive 7-day / 1-day window
  return { granularity, from: addDays(endDate, -span), to: endDate };
}

/** The equal-length window immediately preceding `current`. */
function priorWindowFor(granularity: Granularity, current: MetricsWindow): MetricsWindow {
  const span = granularity === 'weekly' ? 6 : 0;
  const to = addDays(current.from, -1);
  return { granularity, from: addDays(to, -span), to };
}

/** Sum per-login account summaries into one aggregate snapshot. */
function aggregateAccounts(summaries: readonly AccountSummary[]): AccountSummary {
  if (summaries.length === 1) return summaries[0] as AccountSummary;
  const first = summaries[0];
  return {
    login: first?.login ?? 0,
    currency: first?.currency ?? 'USD',
    balance: summaries.reduce((a, s) => a + s.balance, 0),
    equity: summaries.reduce((a, s) => a + s.equity, 0),
    margin: summaries.reduce((a, s) => a + s.margin, 0),
    openPnL: summaries.reduce((a, s) => a + s.openPnL, 0),
  };
}

async function gatherWindow(
  conns: MetricsConnectors,
  logins: readonly number[],
  window: MetricsWindow,
  asOf: string,
  includeOpen: boolean,
): Promise<WindowData> {
  const closedPerLogin = await Promise.all(
    logins.map((login) => conns.mt5.getClosedTrades(login, window.from, window.to)),
  );
  const summaries = await Promise.all(logins.map((login) => conns.mt5.getAccountSummary(login)));
  const openPerLogin = includeOpen
    ? await Promise.all(logins.map((login) => conns.mt5.getOpenPositions(login)))
    : [];

  return {
    window,
    account: aggregateAccounts(summaries),
    closedTrades: closedPerLogin.flat(),
    openPositions: openPerLogin.flat(),
    asOf,
  };
}

/**
 * Fetch the data needed to compute a client's metrics for a window (and
 * optionally the prior window). Open positions are gathered for the current
 * window only (they reflect present state).
 */
export async function gatherMetricsInput(
  conns: MetricsConnectors,
  params: GatherParams,
): Promise<MetricsInput> {
  const client = await conns.brokeret.getClient(params.crmClientId);
  const logins = client.mt5Logins;

  const current = windowFor(params.granularity, params.referenceDate);
  const asOf = params.asOf ?? `${params.referenceDate}T23:59:59.999Z`;

  const currentData = await gatherWindow(conns, logins, current, asOf, true);

  const input: MetricsInput = { crmClientId: params.crmClientId, current: currentData };
  if (!params.includePrior) return input;

  const prior = priorWindowFor(params.granularity, current);
  const priorData = await gatherWindow(conns, logins, prior, `${prior.to}T23:59:59.999Z`, false);
  return { ...input, prior: priorData };
}
