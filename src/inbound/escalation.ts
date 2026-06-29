/**
 * Escalation triggers — route to a human instead of an AI reply. Casual
 * market-call questions are NOT escalations (the mentor deflects those); only
 * explicit demands for regulated advice escalate.
 */
import type { EscalationReason } from './types.js';

interface Trigger {
  readonly reason: EscalationReason;
  readonly pattern: RegExp;
}

const TRIGGERS: readonly Trigger[] = [
  {
    reason: 'complaint',
    pattern:
      /\b(complaint|complain|scam|fraud|fraudulent|rip(ped)? ?off|terrible service|disgrace|unacceptable|i'?m (furious|livid)|report you|sue you|take legal|lawyer|ombudsman|regulator)\b/i,
  },
  {
    reason: 'funds_problem',
    pattern:
      /\b(can'?t (withdraw|access|get)|withdrawal (problem|issue|stuck|pending|denied|declined)|deposit (problem|issue|stuck|missing|failed)|my (money|funds?) (is|are)? ?(stuck|missing|gone|frozen|locked)|account (locked|frozen|suspended|blocked)|chargeback)\b/i,
  },
  {
    reason: 'advice_demand',
    pattern:
      /\b(just tell me (what|which|when) to (buy|sell|trade)|give me (a |the )?(signal|tip|call)|tell me exactly (what|when) to (buy|sell|trade)|i (want|need) (financial|investment) advice|where should i put my money|manage my money for me)\b/i,
  },
];

/** Detect an escalation trigger in the inbound text, or null. */
export function detectEscalation(text: string): EscalationReason | null {
  for (const t of TRIGGERS) {
    if (t.pattern.test(text)) return t.reason;
  }
  return null;
}
