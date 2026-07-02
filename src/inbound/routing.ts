/**
 * Complexity routing: simple metric lookups are answered deterministically from
 * the metrics engine with NO LLM call. Anything coaching/open-ended goes to the
 * model. A message that mentions a metric but is phrased as coaching ("how do I
 * reduce my drawdown?") is NOT a lookup.
 *
 * Detection runs on the inbound English keywords; the deterministic answer is
 * rendered in the client's chosen language (default English).
 */
import { formatPercent } from '../metrics/index.js';
import type { ClientMetrics } from '../metrics/index.js';
import { DEFAULT_LANGUAGE, periodPhrase, t, type Language, type Strings } from '../i18n/index.js';

const COACHING_CUE =
  /\b(how (do|can|should) i|why|should i|what should|help me|explain|advice|improve|reduce|increase|fix|feel|think|strategy|better|worried|nervous|scared|afraid|tips?|coach|teach|learn|understand)\b/i;

/** Safe read of a preformatted display string (display is a string map). */
function d(m: ClientMetrics, key: string): string {
  return m.display[key] ?? '';
}

interface Lookup {
  readonly pattern: RegExp;
  readonly answer: (m: ClientMetrics, s: Strings, period: string) => string;
}

const LOOKUPS: readonly Lookup[] = [
  {
    pattern: /\b(draw\s?down|dd)\b/i,
    answer: (m, s, period) =>
      s.lookupDrawdown({ period, dd: d(m, 'maxDrawdown'), ddPct: d(m, 'maxDrawdownPct') }),
  },
  {
    pattern: /\b(win\s?rate|winning percentage|how often.*win)\b/i,
    answer: (m, s, period) =>
      m.numTrades > 0
        ? s.lookupWinRate({ period, winRate: d(m, 'winRate'), wins: m.wins, losses: m.losses })
        : s.lookupWinRateNone({ period }),
  },
  {
    pattern: /\b(how many trades|number of trades|trade count|how many.*(did i (take|make|close)|trades))\b/i,
    answer: (m, s, period) => s.lookupTradeCount({ period, n: m.numTrades }),
  },
  {
    pattern: /\b(p\s?&?\s?l|pnl|net result|net p&l|how much.*(made|lost|profit|down|up))\b/i,
    answer: (m, s, period) => s.lookupPnl({ period, pnl: d(m, 'totalPnL') }),
  },
  {
    pattern: /\b(open (positions?|risk|trades)|how many.*open|what.*open)\b/i,
    answer: (m, s) =>
      s.lookupOpenPositions({
        n: m.openRisk.openPositions,
        openPnL: d(m, 'openPnL'),
        margin: d(m, 'marginUtilization'),
      }),
  },
  {
    pattern: /\b(best trade|biggest win)\b/i,
    answer: (m, s, period) => s.lookupBestTrade({ period, best: d(m, 'bestTrade') }),
  },
  {
    pattern: /\b(worst trade|biggest loss)\b/i,
    answer: (m, s, period) => s.lookupWorstTrade({ period, worst: d(m, 'worstTrade') }),
  },
  {
    pattern: /\b(exposure|concentration|most traded)\b/i,
    answer: (m, s) =>
      m.openRisk.openPositions > 0
        ? s.lookupExposure({
            pct: formatPercent(m.topSymbolShare),
            symbol: m.mostTradedSymbols[0]?.symbol ?? s.singleInstrument,
          })
        : s.lookupExposureNone,
  },
];

export interface LookupAnswer {
  readonly answer: string;
}

/**
 * If `text` is a simple metric lookup, return a deterministic answer (in the
 * given language); otherwise null (route to the model). Long or coaching-phrased
 * messages are not lookups.
 */
export function tryLookup(
  text: string,
  metrics: ClientMetrics,
  language: Language = DEFAULT_LANGUAGE,
): LookupAnswer | null {
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 14 || COACHING_CUE.test(text)) return null;
  const s = t(language);
  const period = periodPhrase(language, metrics.window.granularity);
  for (const l of LOOKUPS) {
    if (l.pattern.test(text)) return { answer: l.answer(metrics, s, period) };
  }
  return null;
}
