/**
 * Pure, deterministic metrics computation. No I/O, no LLM, no API calls — just
 * math over raw connector data. This is the *only* place financial arithmetic
 * happens; the AI later narrates these numbers but never computes them.
 */
import type { AccountSummary, ClosedTrade, OpenPosition } from '../connectors/mt5/types.js';
import { METRICS_THRESHOLDS as T } from './constants.js';
import { formatCurrency, formatDuration, formatPercent, round2 } from './format.js';
import { buildBehavioralObservations } from './observations.js';
import type {
  BehavioralFlags,
  ClientMetrics,
  DrawdownStat,
  FlagEvidence,
  MetricsDelta,
  MetricsInput,
  OpenRiskStat,
  SymbolStat,
  TradeRef,
  WindowData,
} from './types.js';

const DAY_MS = 86_400_000;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** Net result of a trade: gross profit plus swap and commission costs. */
export function netProfit(trade: ClosedTrade): number {
  return trade.profit + trade.swap + trade.commission;
}

function holdMs(trade: ClosedTrade): number {
  return Math.max(0, ms(trade.closeTime) - ms(trade.openTime));
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function toTradeRef(trade: ClosedTrade, currency: string): TradeRef {
  const net = netProfit(trade);
  const hold = holdMs(trade);
  return {
    ticket: trade.ticket,
    symbol: trade.symbol,
    direction: trade.direction,
    netProfit: round2(net),
    openTime: trade.openTime,
    closeTime: trade.closeTime,
    holdMs: hold,
    display: { netProfit: formatCurrency(net, currency), hold: formatDuration(hold) },
  };
}

// ── Per-window core stats ────────────────────────────────────────────────────
interface WindowCore {
  numTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalPnL: number;
  grossProfit: number;
  grossLoss: number;
  totalCosts: number;
  averageHoldMs: number | null;
  longestHoldMs: number | null;
  averageWinHoldMs: number | null;
  averageLossHoldMs: number | null;
  bestTrade: ClosedTrade | null;
  worstTrade: ClosedTrade | null;
  symbols: SymbolStat[];
  drawdown: DrawdownStat;
}

function computeCore(trades: readonly ClosedTrade[], balance: number): WindowCore {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnL = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalCosts = 0;
  let best: ClosedTrade | null = null;
  let worst: ClosedTrade | null = null;
  const allHolds: number[] = [];
  const winHolds: number[] = [];
  const lossHolds: number[] = [];

  for (const t of trades) {
    const net = netProfit(t);
    totalPnL += net;
    totalCosts += t.swap + t.commission;
    const hold = holdMs(t);
    allHolds.push(hold);

    if (net > 0) {
      wins += 1;
      grossProfit += net;
      winHolds.push(hold);
    } else if (net < 0) {
      losses += 1;
      grossLoss += -net;
      lossHolds.push(hold);
    } else {
      breakeven += 1;
    }

    if (best === null || net > netProfit(best)) best = t;
    if (worst === null || net < netProfit(worst)) worst = t;
  }

  const numTrades = trades.length;
  return {
    numTrades,
    wins,
    losses,
    breakeven,
    winRate: numTrades > 0 ? wins / numTrades : 0,
    totalPnL: round2(totalPnL),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    totalCosts: round2(totalCosts),
    averageHoldMs: mean(allHolds),
    longestHoldMs: allHolds.length > 0 ? Math.max(...allHolds) : null,
    averageWinHoldMs: mean(winHolds),
    averageLossHoldMs: mean(lossHolds),
    bestTrade: best,
    worstTrade: worst,
    symbols: computeSymbols(trades),
    drawdown: computeDrawdown(trades, balance),
  };
}

function computeSymbols(trades: readonly ClosedTrade[]): SymbolStat[] {
  const map = new Map<string, { trades: number; volume: number; netProfit: number }>();
  for (const t of trades) {
    const cur = map.get(t.symbol) ?? { trades: 0, volume: 0, netProfit: 0 };
    cur.trades += 1;
    cur.volume += t.volume;
    cur.netProfit += netProfit(t);
    map.set(t.symbol, cur);
  }
  return [...map.entries()]
    .map(([symbol, s]) => ({
      symbol,
      trades: s.trades,
      volume: round2(s.volume),
      netProfit: round2(s.netProfit),
    }))
    .sort((a, b) => b.trades - a.trades || b.volume - a.volume || a.symbol.localeCompare(b.symbol))
    .slice(0, T.topSymbolsCount);
}

/**
 * Max peak-to-trough decline of the cumulative net-P&L curve (ordered by close
 * time, starting at 0). `maxDrawdownPct` is relative to account balance.
 */
function computeDrawdown(trades: readonly ClosedTrade[], balance: number): DrawdownStat {
  const ordered = [...trades].sort((a, b) => ms(a.closeTime) - ms(b.closeTime));
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ordered) {
    cumulative += netProfit(t);
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    maxDrawdown: round2(maxDd),
    maxDrawdownPct: balance > 0 ? round2((maxDd / balance) * 100) / 100 : 0,
  };
}

// ── Open risk + exposure concentration ───────────────────────────────────────
function computeOpenRisk(account: AccountSummary, open: readonly OpenPosition[]): OpenRiskStat {
  const openVolume = open.reduce((a, p) => a + p.volume, 0);
  const openPnL = open.reduce((a, p) => a + p.unrealizedPnL, 0);
  const equity = account.equity;
  return {
    openPositions: open.length,
    openVolume: round2(openVolume),
    openPnL: round2(openPnL),
    marginUsed: round2(account.margin),
    marginUtilization: equity > 0 ? account.margin / equity : 0,
  };
}

/** Herfindahl concentration (0..1) of open exposure by symbol (volume-based). */
function computeConcentration(open: readonly OpenPosition[]): {
  hhi: number;
  topShare: number;
  topSymbol: string | null;
} {
  if (open.length === 0) return { hhi: 0, topShare: 0, topSymbol: null };
  const bySymbol = new Map<string, number>();
  let total = 0;
  for (const p of open) {
    bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + p.volume);
    total += p.volume;
  }
  if (total <= 0) return { hhi: 0, topShare: 0, topSymbol: null };

  let hhi = 0;
  let topShare = 0;
  let topSymbol: string | null = null;
  for (const [symbol, vol] of bySymbol) {
    const share = vol / total;
    hhi += share * share;
    if (share > topShare) {
      topShare = share;
      topSymbol = symbol;
    }
  }
  return { hhi: round2(hhi * 100) / 100, topShare, topSymbol };
}

// ── Behavioral flags ─────────────────────────────────────────────────────────
function spansWeekend(startMs: number, endMs: number): boolean {
  if (endMs <= startMs) return false;
  const firstDay = Math.floor(startMs / DAY_MS) * DAY_MS;
  for (let t = firstDay; t < endMs; t += DAY_MS) {
    const dow = new Date(t).getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) {
      if (Math.max(t, startMs) < Math.min(t + DAY_MS, endMs)) return true;
    }
    if (t - firstDay > 400 * DAY_MS) break; // safety
  }
  return false;
}

interface FlagResult {
  flags: BehavioralFlags;
  evidence: FlagEvidence;
}

function computeFlags(
  data: WindowData,
  core: WindowCore,
  openRisk: OpenRiskStat,
): FlagResult {
  const asOfMs = ms(data.asOf);

  // Weekend holding: any closed trade held across a weekend, or any open
  // position held from before a weekend up to `asOf`.
  let weekendHeldTrades = 0;
  let weekendLossAmount = 0;
  for (const t of data.closedTrades) {
    if (spansWeekend(ms(t.openTime), ms(t.closeTime))) {
      weekendHeldTrades += 1;
      const net = netProfit(t);
      if (net < 0) weekendLossAmount += -net;
    }
  }
  let weekendOpenHeld = 0;
  for (const p of data.openPositions) {
    if (spansWeekend(ms(p.openTime), asOfMs)) weekendOpenHeld += 1;
  }
  const weekendHolding = weekendHeldTrades > 0 || weekendOpenHeld > 0;
  const weekendLossShare = core.grossLoss > 0 ? weekendLossAmount / core.grossLoss : 0;

  // Overleveraging: margin uses a large share of equity.
  const overleveraging = openRisk.marginUtilization > T.overleverageMarginRatio;

  // Revenge: a new trade opened shortly after a loss closes.
  const lossCloseTimes = data.closedTrades
    .filter((t) => netProfit(t) < 0)
    .map((t) => ms(t.closeTime));
  let revengeTrades = 0;
  for (const t of data.closedTrades) {
    const openAt = ms(t.openTime);
    const isRevenge = lossCloseTimes.some(
      (closeAt) => closeAt < openAt && openAt - closeAt <= T.revengeWindowMs,
    );
    if (isRevenge) revengeTrades += 1;
  }
  const revengeTrading = revengeTrades >= T.revengeMinTrades;

  // Clustering: trades opened in rapid bursts.
  const opens = data.closedTrades.map((t) => ms(t.openTime)).sort((a, b) => a - b);
  let largestBurst = 0;
  const inBurst = new Array<boolean>(opens.length).fill(false);
  let lo = 0;
  for (let hi = 0; hi < opens.length; hi += 1) {
    while ((opens[hi] as number) - (opens[lo] as number) > T.clusterWindowMs) lo += 1;
    const count = hi - lo + 1;
    if (count > largestBurst) largestBurst = count;
    if (count >= T.clusterMinTrades) {
      for (let k = lo; k <= hi; k += 1) inBurst[k] = true;
    }
  }
  const burstTrades = inBurst.filter(Boolean).length;
  const tradeClustering = largestBurst >= T.clusterMinTrades;

  return {
    flags: { weekendHolding, overleveraging, revengeTrading, tradeClustering },
    evidence: {
      weekendHeldTrades: weekendHeldTrades + weekendOpenHeld,
      weekendLossShare,
      marginUtilization: openRisk.marginUtilization,
      revengeTrades,
      burstTrades,
      largestBurst,
    },
  };
}

// ── Week-over-week deltas ────────────────────────────────────────────────────
function computeDeltas(cur: WindowCore, prior: WindowCore, currency: string): MetricsDelta {
  const numTrades = cur.numTrades - prior.numTrades;
  const totalPnL = round2(cur.totalPnL - prior.totalPnL);
  const winRate = cur.winRate - prior.winRate;
  const averageHoldMs =
    cur.averageHoldMs !== null && prior.averageHoldMs !== null
      ? cur.averageHoldMs - prior.averageHoldMs
      : null;
  return {
    numTrades,
    totalPnL,
    winRate,
    averageHoldMs,
    display: {
      numTrades: numTrades > 0 ? `+${numTrades}` : `${numTrades}`,
      totalPnL: signedCurrency(totalPnL, currency),
      winRate: signedPoints(winRate),
    },
  };
}

function signedCurrency(amount: number, currency: string): string {
  if (round2(amount) === 0) return formatCurrency(0, currency);
  return (amount > 0 ? '+' : '-') + formatCurrency(Math.abs(amount), currency);
}

function signedPoints(deltaRatio: number): string {
  const pts = deltaRatio * 100;
  const sign = pts > 0 ? '+' : pts < 0 ? '-' : '';
  return `${sign}${Math.abs(pts).toFixed(1)}pp`;
}

// ── Public entry point ───────────────────────────────────────────────────────
/**
 * Compute the full {@link ClientMetrics} for a client window. Pure: same input
 * always yields the same output.
 */
export function computeClientMetrics(input: MetricsInput): ClientMetrics {
  const { current } = input;
  const currency = current.account.currency || 'USD';
  const core = computeCore(current.closedTrades, current.account.balance);
  const openRisk = computeOpenRisk(current.account, current.openPositions);
  const concentration = computeConcentration(current.openPositions);
  const { flags, evidence } = computeFlags(current, core, openRisk);

  const deltas = input.prior
    ? computeDeltas(core, computeCore(input.prior.closedTrades, input.prior.account.balance), currency)
    : null;

  const bestTrade = core.bestTrade ? toTradeRef(core.bestTrade, currency) : null;
  const worstTrade = core.worstTrade ? toTradeRef(core.worstTrade, currency) : null;

  const behavioralObservations = buildBehavioralObservations({
    granularity: current.window.granularity,
    currency,
    core,
    flags,
    evidence,
    openRisk,
    concentration,
    bestTrade,
    worstTrade,
    deltas,
  });

  const display: Record<string, string> = {
    totalPnL: formatCurrency(core.totalPnL, currency),
    winRate: core.numTrades > 0 ? formatPercent(core.winRate) : 'N/A',
    numTrades: String(core.numTrades),
    record: `${core.wins}W / ${core.losses}L${core.breakeven > 0 ? ` / ${core.breakeven}BE` : ''}`,
    bestTrade: bestTrade ? `${bestTrade.display.netProfit} (${bestTrade.symbol})` : 'N/A',
    worstTrade: worstTrade ? `${worstTrade.display.netProfit} (${worstTrade.symbol})` : 'N/A',
    averageHold: formatDuration(core.averageHoldMs),
    longestHold: formatDuration(core.longestHoldMs),
    maxDrawdown: formatCurrency(core.drawdown.maxDrawdown, currency),
    maxDrawdownPct: formatPercent(core.drawdown.maxDrawdownPct),
    openPnL: formatCurrency(openRisk.openPnL, currency),
    openPositions: String(openRisk.openPositions),
    marginUtilization: formatPercent(openRisk.marginUtilization),
    exposureConcentration: formatPercent(concentration.hhi),
    topSymbol: concentration.topSymbol
      ? `${concentration.topSymbol} (${formatPercent(concentration.topShare)})`
      : 'N/A',
  };

  return {
    crmClientId: input.crmClientId,
    window: current.window,
    asOf: current.asOf,
    currency,
    numTrades: core.numTrades,
    wins: core.wins,
    losses: core.losses,
    breakeven: core.breakeven,
    winRate: core.winRate,
    totalPnL: core.totalPnL,
    grossProfit: core.grossProfit,
    grossLoss: core.grossLoss,
    totalCosts: core.totalCosts,
    bestTrade,
    worstTrade,
    averageHoldMs: core.averageHoldMs,
    longestHoldMs: core.longestHoldMs,
    averageWinHoldMs: core.averageWinHoldMs,
    averageLossHoldMs: core.averageLossHoldMs,
    mostTradedSymbols: core.symbols,
    exposureConcentration: concentration.hhi,
    topSymbolShare: concentration.topShare,
    drawdown: core.drawdown,
    openRisk,
    deltas,
    flags,
    flagEvidence: evidence,
    behavioralObservations,
    display,
  };
}
