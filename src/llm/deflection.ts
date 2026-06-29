/**
 * Educational replacements built purely from a client's own computed metrics —
 * never predictions. `buildDeflection` redirects a market-call request back to
 * the client's exposure (chat substitution). `buildDeterministicReport` is the
 * numbers-only fallback the daily report uses when a generation is rejected.
 */
import { formatPercent } from '../metrics/format.js';
import type { ClientMetrics } from '../metrics/types.js';

/**
 * A factual, educational deflection redirecting to the client's own exposure.
 * Uses only numbers present in `metrics`.
 */
export function buildDeflection(metrics?: ClientMetrics): string {
  const base =
    "I can't make market calls, price predictions, or buy/sell/hold recommendations — that's not something I'll ever do.";

  if (metrics && metrics.openRisk.openPositions > 0 && metrics.topSymbolShare > 0) {
    const topSymbol = metrics.mostTradedSymbols[0]?.symbol;
    const exposure =
      topSymbol !== undefined
        ? `${formatPercent(metrics.topSymbolShare)} of your current open risk is concentrated in ${topSymbol}`
        : `${formatPercent(metrics.topSymbolShare)} of your current open risk sits in a single instrument`;
    return (
      `${base} What I can do is help you think about your own exposure: ${exposure}, ` +
      `and your margin is using ${formatPercent(metrics.openRisk.marginUtilization)} of your equity. ` +
      `Want to talk through how that sits against your account size?`
    );
  }

  if (metrics && metrics.numTrades > 0) {
    return (
      `${base} What I can do is help you reflect on your own history — for example, your win rate this ` +
      `${metrics.window.granularity === 'daily' ? 'day' : 'week'} was ${metrics.display.winRate} across ` +
      `${metrics.numTrades} trades, with a net result of ${metrics.display.totalPnL}. ` +
      `Want to dig into what's working and what isn't?`
    );
  }

  return `${base} What I can do is help you understand your own positions, risk, and habits. What would you like to look at?`;
}

/**
 * Deterministic, numbers-only report assembled directly from computed metrics.
 * No LLM, no invented figures — every value comes from `metrics`.
 */
export function buildDeterministicReport(metrics: ClientMetrics): string {
  const period = metrics.window.granularity === 'daily' ? 'daily' : 'weekly';
  const lines: string[] = [
    `Your ${period} summary (${metrics.window.from} → ${metrics.window.to})`,
    '',
    `Net P&L: ${metrics.display.totalPnL}`,
    `Win rate: ${metrics.display.winRate} (${metrics.display.record})`,
    `Best trade: ${metrics.display.bestTrade}`,
    `Worst trade: ${metrics.display.worstTrade}`,
    `Avg hold: ${metrics.display.averageHold}  |  Max drawdown: ${metrics.display.maxDrawdown} (${metrics.display.maxDrawdownPct})`,
    `Open risk: ${metrics.display.openPositions} position(s), ${metrics.display.openPnL} unrealized, margin ${metrics.display.marginUtilization}`,
  ];

  if (metrics.behavioralObservations.length > 0) {
    lines.push('', 'What stood out:');
    for (const o of metrics.behavioralObservations) lines.push(`• ${o}`);
  }

  return lines.join('\n');
}
