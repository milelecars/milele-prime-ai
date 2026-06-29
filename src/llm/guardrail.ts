/**
 * Post-generation guardrail. Scans model output BEFORE it is sent and flags
 * forbidden content (market calls, trade instructions, price predictions,
 * signals). Two layers:
 *   1. deterministic rules — instant and free (catches the obvious cases);
 *   2. a cheap classifier LLM call — backstop for subtler phrasing.
 *
 * The caller decides what to do on a trip: the daily report falls back to a
 * deterministic template; the chat substitutes the deflection. Every trip
 * should be written to audit_log (see {@link guardrailAuditEvent}).
 */
import type { AuditEvent } from '../identity/repository.js';
import type { ClientMetrics } from '../metrics/types.js';
import { buildDeflection } from './deflection.js';
import { scanRules, type GuardrailCategory } from './rules.js';

export interface ClassifierVerdict {
  readonly forbidden: boolean;
  readonly category?: string | null;
  readonly reason?: string | null;
}

/** Classifier backstop. Returns whether the text is forbidden. */
export type Classifier = (text: string) => Promise<ClassifierVerdict>;

export interface CheckOptions {
  /** Backstop classifier. If omitted, only the rules layer runs. */
  readonly classifier?: Classifier;
  /** The client's metrics, used to build a data-specific deflection. */
  readonly metrics?: ClientMetrics;
  /** Invoked on a trip (e.g. to write audit_log). Awaited. */
  readonly onTrip?: (result: GuardrailTrip) => Promise<void> | void;
}

export interface GuardrailTrip {
  readonly tripped: true;
  readonly layer: 'rules' | 'classifier';
  readonly category: GuardrailCategory | string;
  readonly reason: string;
  /** The matched snippet (rules layer) if available. */
  readonly match?: string;
  /** Educational replacement message. */
  readonly deflection: string;
}

export interface GuardrailPass {
  readonly tripped: false;
  readonly layer: null;
  readonly category: null;
  readonly reason: null;
  readonly deflection: null;
}

export type GuardrailResult = GuardrailTrip | GuardrailPass;

const PASS: GuardrailPass = {
  tripped: false,
  layer: null,
  category: null,
  reason: null,
  deflection: null,
};

/**
 * Scan `text` for forbidden content. Rules first (free); classifier second
 * (only if provided and the rules pass).
 */
export async function checkOutbound(
  text: string,
  options: CheckOptions = {},
): Promise<GuardrailResult> {
  // Layer 1 — deterministic rules.
  const hit = scanRules(text);
  if (hit) {
    const trip: GuardrailTrip = {
      tripped: true,
      layer: 'rules',
      category: hit.category,
      reason: hit.reason,
      match: hit.match,
      deflection: buildDeflection(options.metrics),
    };
    await options.onTrip?.(trip);
    return trip;
  }

  // Layer 2 — classifier backstop.
  if (options.classifier) {
    const verdict = await options.classifier(text);
    if (verdict.forbidden) {
      const trip: GuardrailTrip = {
        tripped: true,
        layer: 'classifier',
        category: verdict.category ?? 'unspecified',
        reason: verdict.reason ?? 'classifier flagged forbidden content',
        deflection: buildDeflection(options.metrics),
      };
      await options.onTrip?.(trip);
      return trip;
    }
  }

  return PASS;
}

/** Build an audit_log event for a guardrail trip (caller persists it). */
export function guardrailAuditEvent(
  crmClientId: string | null,
  trip: GuardrailTrip,
  textSnippet: string,
): AuditEvent {
  return {
    crmClientId,
    eventType: 'guardrail_trip',
    detail: {
      layer: trip.layer,
      category: trip.category,
      reason: trip.reason,
      ...(trip.match ? { match: trip.match } : {}),
      snippet: textSnippet.slice(0, 280),
    },
  };
}
