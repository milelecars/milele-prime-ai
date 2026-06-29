/**
 * Graceful exit at budget cap: a rotating sign-off + a one-line recap and a
 * single piece of "homework" drawn from the session. No model call.
 */
import type { ClientMetrics } from '../metrics/index.js';
import type { SessionState } from './types.js';

/** A concrete takeaway for the "homework" slot, derived from the client's data. */
function homework(metrics: ClientMetrics): string {
  if (metrics.flags.weekendHolding) return 'review how your weekend holds are affecting your results';
  if (metrics.flags.overleveraging) return 'look at your margin usage relative to your account size';
  if (metrics.flags.revengeTrading) return 'notice the trades you open right after a loss';
  const obs = metrics.behavioralObservations[0];
  if (obs) return `sit with this — ${obs.replace(/\.$/, '')}`;
  return 'review your own numbers before your next session';
}

/** A one-line recap from the rolling summary, falling back to the metrics. */
function recap(state: SessionState, metrics: ClientMetrics): string {
  if (state.rollingSummary.trim()) return state.rollingSummary.trim();
  if (metrics.numTrades > 0) {
    return `${metrics.numTrades} trades, ${metrics.display.winRate} win rate, ${metrics.display.totalPnL} net this ${
      metrics.window.granularity === 'daily' ? 'day' : 'week'
    }.`;
  }
  return 'we focused on your habits and your current exposure.';
}

/** Build the graceful exit message, rotating among three variants. */
export function buildExitMessage(state: SessionState, metrics: ClientMetrics): string {
  const variant = state.startedAt % 3;
  if (variant === 0) {
    return "I've gotta get back to watching the charts — but think on what we covered. Message me anytime.";
  }
  if (variant === 1) {
    return `Markets don't sleep, so I'm back to the screens. Homework: ${homework(metrics)}. Talk soon.`;
  }
  return `Stepping away to keep an eye on things. Quick recap: ${recap(state, metrics)} I'm around later.`;
}

/** Short cooldown message while the budget is resetting. */
export function buildCooldownMessage(): string {
  return "I'm still catching my breath from our last chat — give me a few minutes and message me again. I'll be fresh and ready.";
}
