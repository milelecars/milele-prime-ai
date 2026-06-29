/**
 * Builds plain-language, FACTUAL observations about a user's own trading
 * history. Every statement is backward-looking or describes current state —
 * never a market prediction or forward-looking claim. Pure.
 */
import { METRICS_THRESHOLDS as T } from './constants.js';
import {
  formatCurrency,
  formatDuration,
  formatMultiplier,
  formatPercent,
  formatSignedCurrency,
} from './format.js';
import type {
  BehavioralFlags,
  DrawdownStat,
  FlagEvidence,
  MetricsDelta,
  OpenRiskStat,
  TradeRef,
} from './types.js';

interface CoreLike {
  readonly numTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly totalPnL: number;
  readonly grossLoss: number;
  readonly averageWinHoldMs: number | null;
  readonly averageLossHoldMs: number | null;
  readonly drawdown: DrawdownStat;
}

export interface ObservationContext {
  readonly granularity: 'daily' | 'weekly';
  readonly currency: string;
  readonly core: CoreLike;
  readonly flags: BehavioralFlags;
  readonly evidence: FlagEvidence;
  readonly openRisk: OpenRiskStat;
  readonly concentration: { readonly topShare: number; readonly topSymbol: string | null };
  readonly bestTrade: TradeRef | null;
  readonly worstTrade: TradeRef | null;
  readonly deltas: MetricsDelta | null;
}

const plural = (n: number, singular: string, pluralForm = `${singular}s`): string =>
  n === 1 ? singular : pluralForm;

export function buildBehavioralObservations(ctx: ObservationContext): string[] {
  const { core, flags, evidence, openRisk, concentration, currency } = ctx;
  const period = ctx.granularity === 'daily' ? 'day' : 'week';
  const out: string[] = [];

  // Activity + result
  if (core.numTrades === 0) {
    out.push(`You had no closed trades this ${period}.`);
  } else {
    out.push(
      `You closed ${core.numTrades} ${plural(core.numTrades, 'trade')} this ${period} ` +
        `with a ${formatPercent(core.winRate)} win rate ` +
        `(${core.wins} ${plural(core.wins, 'win')}, ${core.losses} ${plural(core.losses, 'loss', 'losses')}).`,
    );
    out.push(`Your net result was ${formatSignedCurrency(core.totalPnL, currency)}.`);
  }

  // Best / worst
  if (core.numTrades === 1 && ctx.bestTrade) {
    out.push(`Your only trade returned ${ctx.bestTrade.display.netProfit} on ${ctx.bestTrade.symbol}.`);
  } else if (ctx.bestTrade && ctx.worstTrade) {
    out.push(
      `Your best trade was ${ctx.bestTrade.display.netProfit} on ${ctx.bestTrade.symbol}; ` +
        `your worst was ${ctx.worstTrade.display.netProfit} on ${ctx.worstTrade.symbol}.`,
    );
  }

  // Hold-time asymmetry (winners vs losers)
  if (
    core.averageWinHoldMs !== null &&
    core.averageLossHoldMs !== null &&
    core.averageLossHoldMs > 0
  ) {
    const ratio = core.averageWinHoldMs / core.averageLossHoldMs;
    out.push(
      `Your average hold time on winners (${formatDuration(core.averageWinHoldMs)}) is ` +
        `${formatMultiplier(ratio)} your losers (${formatDuration(core.averageLossHoldMs)}).`,
    );
  }

  // Weekend holding
  if (flags.weekendHolding) {
    if (core.grossLoss > 0 && evidence.weekendLossShare > 0) {
      out.push(
        `${formatPercent(evidence.weekendLossShare)} of your losses came from positions held over the weekend.`,
      );
    } else {
      out.push(`You held ${plural(evidence.weekendHeldTrades, 'a position', 'positions')} across a weekend this ${period}.`);
    }
  }

  // Revenge trading
  if (evidence.revengeTrades > 0) {
    const minutes = Math.round(T.revengeWindowMs / 60_000);
    out.push(
      `On ${evidence.revengeTrades} ${plural(evidence.revengeTrades, 'occasion')} you opened a new trade ` +
        `within ${minutes} minutes of closing a loss.`,
    );
  }

  // Clustering
  if (flags.tradeClustering) {
    const minutes = Math.round(T.clusterWindowMs / 60_000);
    out.push(
      `You placed trades in rapid bursts — up to ${evidence.largestBurst} within ${minutes} minutes.`,
    );
  }

  // Overleveraging
  if (flags.overleveraging) {
    out.push(`Your open margin uses ${formatPercent(openRisk.marginUtilization)} of your account equity.`);
  }

  // Drawdown
  if (core.drawdown.maxDrawdown > 0) {
    out.push(
      `Within this ${period} your running P&L fell as much as ` +
        `${formatCurrency(core.drawdown.maxDrawdown, currency)} ` +
        `(${formatPercent(core.drawdown.maxDrawdownPct)} of your balance) from its peak.`,
    );
  }

  // Open exposure concentration
  if (openRisk.openPositions > 0 && concentration.topSymbol && concentration.topShare > 0) {
    out.push(
      `${formatPercent(concentration.topShare)} of your current open exposure is in ${concentration.topSymbol}.`,
    );
    if (openRisk.openPnL !== 0) {
      out.push(
        `You currently hold ${openRisk.openPositions} open ${plural(openRisk.openPositions, 'position')} ` +
          `with ${formatSignedCurrency(openRisk.openPnL, currency)} unrealized.`,
      );
    }
  }

  // Week-over-week
  if (ctx.deltas) {
    out.push(
      `Compared with the prior ${period}, your trade count changed by ${ctx.deltas.display.numTrades}, ` +
        `net P&L by ${ctx.deltas.display.totalPnL}, and win rate by ${ctx.deltas.display.winRate}.`,
    );
  }

  return out;
}
