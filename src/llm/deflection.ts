/**
 * Educational replacements built purely from a client's own computed metrics —
 * never predictions. `buildDeflection` redirects a market-call request back to
 * the client's exposure (chat substitution). `buildDeterministicReport` is the
 * numbers-only fallback the daily report uses when a generation is rejected.
 *
 * Both are localized to the client's chosen language (default English); numbers
 * come pre-formatted from `metrics.display.*` and are never altered.
 */
import { formatPercent } from '../metrics/format.js';
import type { ClientMetrics } from '../metrics/types.js';
import { DEFAULT_LANGUAGE, periodAdjective, periodPhrase, t, type Language } from '../i18n/index.js';

/** Safe read of a preformatted display string (display is a string map). */
function d(metrics: ClientMetrics, key: string): string {
  return metrics.display[key] ?? '';
}

/**
 * A factual, educational deflection redirecting to the client's own exposure.
 * Uses only numbers present in `metrics`.
 */
export function buildDeflection(
  metrics?: ClientMetrics,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const s = t(language);

  if (metrics && metrics.openRisk.openPositions > 0 && metrics.topSymbolShare > 0) {
    const topSymbol = metrics.mostTradedSymbols[0]?.symbol;
    const pct = formatPercent(metrics.topSymbolShare);
    const exposure =
      topSymbol !== undefined
        ? s.deflectionExposureFragSymbol({ pct, symbol: topSymbol })
        : s.deflectionExposureFragGeneric({ pct });
    return s.deflectionExposure({
      exposure,
      margin: formatPercent(metrics.openRisk.marginUtilization),
    });
  }

  if (metrics && metrics.numTrades > 0) {
    return s.deflectionHistory({
      period: periodPhrase(language, metrics.window.granularity),
      winRate: d(metrics, 'winRate'),
      n: metrics.numTrades,
      pnl: d(metrics, 'totalPnL'),
    });
  }

  return s.deflectionGeneric;
}

/**
 * Deterministic, numbers-only report assembled directly from computed metrics.
 * No LLM, no invented figures — every value comes from `metrics`.
 */
export function buildDeterministicReport(
  metrics: ClientMetrics,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const s = t(language);
  const period = periodAdjective(language, metrics.window.granularity);
  const lines: string[] = [
    s.report.title({ period, from: metrics.window.from, to: metrics.window.to }),
    '',
    s.report.netPnl({ v: d(metrics, 'totalPnL') }),
    s.report.winRate({ v: d(metrics, 'winRate'), record: d(metrics, 'record') }),
    s.report.bestTrade({ v: d(metrics, 'bestTrade') }),
    s.report.worstTrade({ v: d(metrics, 'worstTrade') }),
    s.report.avgHoldDrawdown({
      avgHold: d(metrics, 'averageHold'),
      dd: d(metrics, 'maxDrawdown'),
      ddPct: d(metrics, 'maxDrawdownPct'),
    }),
    s.report.openRisk({
      n: d(metrics, 'openPositions'),
      openPnL: d(metrics, 'openPnL'),
      margin: d(metrics, 'marginUtilization'),
    }),
  ];

  if (metrics.behavioralObservations.length > 0) {
    lines.push('', s.report.stoodOut);
    for (const o of metrics.behavioralObservations) lines.push(`• ${o}`);
  }

  return lines.join('\n');
}
