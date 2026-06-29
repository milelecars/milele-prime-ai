/**
 * Complexity routing: simple metric lookups are answered deterministically from
 * the metrics engine with NO LLM call. Anything coaching/open-ended goes to the
 * model. A message that mentions a metric but is phrased as coaching ("how do I
 * reduce my drawdown?") is NOT a lookup.
 */
import { formatPercent } from '../metrics/index.js';
import type { ClientMetrics } from '../metrics/index.js';

const COACHING_CUE =
  /\b(how (do|can|should) i|why|should i|what should|help me|explain|advice|improve|reduce|increase|fix|feel|think|strategy|better|worried|nervous|scared|afraid|tips?|coach|teach|learn|understand)\b/i;

interface Lookup {
  readonly pattern: RegExp;
  readonly answer: (m: ClientMetrics) => string;
}

const LOOKUPS: readonly Lookup[] = [
  {
    pattern: /\b(draw\s?down|dd)\b/i,
    answer: (m) =>
      `Your max drawdown this ${period(m)} was ${m.display.maxDrawdown} (${m.display.maxDrawdownPct} of balance).`,
  },
  {
    pattern: /\b(win\s?rate|winning percentage|how often.*win)\b/i,
    answer: (m) =>
      m.numTrades > 0
        ? `Your win rate this ${period(m)} is ${m.display.winRate} — ${m.wins} wins, ${m.losses} losses.`
        : `You have no closed trades this ${period(m)} yet, so there's no win rate to report.`,
  },
  {
    pattern: /\b(how many trades|number of trades|trade count|how many.*(did i (take|make|close)|trades))\b/i,
    answer: (m) => `You closed ${m.numTrades} ${m.numTrades === 1 ? 'trade' : 'trades'} this ${period(m)}.`,
  },
  {
    pattern: /\b(p\s?&?\s?l|pnl|net result|net p&l|how much.*(made|lost|profit|down|up))\b/i,
    answer: (m) => `Your net result this ${period(m)} is ${m.display.totalPnL}.`,
  },
  {
    pattern: /\b(open (positions?|risk|trades)|how many.*open|what.*open)\b/i,
    answer: (m) =>
      `You currently have ${m.openRisk.openPositions} open ${
        m.openRisk.openPositions === 1 ? 'position' : 'positions'
      }, ${m.display.openPnL} unrealized, with margin at ${m.display.marginUtilization} of equity.`,
  },
  {
    pattern: /\b(best trade|biggest win)\b/i,
    answer: (m) => `Your best trade this ${period(m)} was ${m.display.bestTrade}.`,
  },
  {
    pattern: /\b(worst trade|biggest loss)\b/i,
    answer: (m) => `Your worst trade this ${period(m)} was ${m.display.worstTrade}.`,
  },
  {
    pattern: /\b(exposure|concentration|most traded)\b/i,
    answer: (m) =>
      m.openRisk.openPositions > 0
        ? `${formatPercent(m.topSymbolShare)} of your open exposure is in ${m.mostTradedSymbols[0]?.symbol ?? 'a single instrument'}.`
        : `You have no open positions right now.`,
  },
];

function period(m: ClientMetrics): string {
  return m.window.granularity === 'daily' ? 'day' : 'week';
}

export interface LookupAnswer {
  readonly answer: string;
}

/**
 * If `text` is a simple metric lookup, return a deterministic answer; otherwise
 * null (route to the model). Long or coaching-phrased messages are not lookups.
 */
export function tryLookup(text: string, metrics: ClientMetrics): LookupAnswer | null {
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 14 || COACHING_CUE.test(text)) return null;
  for (const l of LOOKUPS) {
    if (l.pattern.test(text)) return { answer: l.answer(metrics) };
  }
  return null;
}
