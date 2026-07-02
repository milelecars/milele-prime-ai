/**
 * Graceful exit at budget cap: a rotating sign-off + a one-line recap and a
 * single piece of "homework" drawn from the session. No model call. Localized
 * to the client's chosen language (default English).
 */
import type { ClientMetrics } from '../metrics/index.js';
import { DEFAULT_LANGUAGE, periodPhrase, t, type Language, type Strings } from '../i18n/index.js';
import type { SessionState } from './types.js';

/** A concrete takeaway for the "homework" slot, derived from the client's data. */
function homework(metrics: ClientMetrics, s: Strings, language: Language): string {
  if (metrics.flags.weekendHolding) return s.homeworkWeekend;
  if (metrics.flags.overleveraging) return s.homeworkOverleverage;
  if (metrics.flags.revengeTrading) return s.homeworkRevenge;
  // The behavioral observations are generated in English; only surface them
  // verbatim when the client is chatting in English.
  if (language === 'en') {
    const obs = metrics.behavioralObservations[0];
    if (obs) return `sit with this — ${obs.replace(/\.$/, '')}`;
  }
  return s.homeworkDefault;
}

/** A one-line recap from the rolling summary, falling back to the metrics. */
function recap(
  state: SessionState,
  metrics: ClientMetrics,
  s: Strings,
  language: Language,
): string {
  // The rolling summary is English (LLM-generated); use it only for English.
  if (language === 'en' && state.rollingSummary.trim()) return state.rollingSummary.trim();
  if (metrics.numTrades > 0) {
    return s.recapMetrics({
      n: metrics.numTrades,
      winRate: metrics.display.winRate ?? '',
      pnl: metrics.display.totalPnL ?? '',
      period: periodPhrase(language, metrics.window.granularity),
    });
  }
  return s.recapDefault;
}

/** Build the graceful exit message, rotating among three variants. */
export function buildExitMessage(
  state: SessionState,
  metrics: ClientMetrics,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const s = t(language);
  const variant = state.startedAt % 3;
  if (variant === 0) return s.exitV0;
  if (variant === 1) return s.exitV1({ homework: homework(metrics, s, language) });
  return s.exitV2({ recap: recap(state, metrics, s, language) });
}

/** Short cooldown message while the budget is resetting. */
export function buildCooldownMessage(language: Language = DEFAULT_LANGUAGE): string {
  return t(language).cooldown;
}
