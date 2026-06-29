/**
 * Deterministic guardrail rules — the fast, free first layer. Pattern matching
 * tuned to catch market calls, trade instructions, price predictions, and
 * signals WITHOUT false-positiving on the user's own factual history
 * (past-tense stats, current-exposure facts, educational explanations).
 *
 * Anchoring principles:
 *  - forward-looking modals ("will / going to / expect / poised to") + a
 *    market verb → market call. Past tense ("rose", "fell", "came from") is
 *    never matched.
 *  - base-form imperatives ("buy", "close") + object → instruction. Inflected
 *    forms ("closes a position", "you held") are not.
 */

export type GuardrailCategory =
  | 'market_call'
  | 'trade_instruction'
  | 'price_prediction'
  | 'signal'
  | 'prompt_injection';

interface Rule {
  readonly category: GuardrailCategory;
  readonly reason: string;
  readonly pattern: RegExp;
}

// Named instruments (case-insensitive). Currency pairs handled separately so a
// lowercase 6-letter English word can never match.
const ASSET =
  '(?:gold|silver|oil|crude|copper|nat ?gas|btc|bitcoin|eth|ethereum|crypto|forex|stocks?|equities|indices|nasdaq|s&p ?500|spx|dow|the dollar|usd|eur|gbp|jpy|aud|nzd|cad|chf|xau|xag)';
const PAIR = '(?:[A-Z]{6}|[A-Z]{3}/[A-Z]{3})'; // EURUSD or EUR/USD — case-sensitive

const DIRECTION =
  '(?:rise|rises|rally|rallies|surge|surges|climb|climbs|jump|jumps|soar|soars|moon|pump|pumps|gain|gains|increase|spike|breakout|break out|rebound|bounce|drop|drops|fall|falls|crash|crashes|dump|dumps|decline|declines|tank|tanks|sink|sinks|reverse|reverses|dip|sell off|sell-off|go up|go down|go higher|go lower|head higher|head lower)';

const RULES: readonly Rule[] = [
  // ── Market calls (forward-looking) ─────────────────────────────────────────
  {
    category: 'market_call',
    reason: 'forward-looking market call',
    pattern: new RegExp(
      `\\b(?:will|won't|will not|gonna|going to|about to|set to|poised to|likely to|expected to|due to|bound to|ready to)\\s+(?:\\w+\\s+){0,2}?${DIRECTION}\\b`,
      'i',
    ),
  },
  {
    category: 'market_call',
    reason: 'predicted market move',
    pattern:
      /\b(?:expect|expecting|anticipate|predict|forecast|foresee|betting on)\s+(?:a|an|the|some|another|more)?\s*(?:rally|surge|drop|crash|breakout|break out|pull ?back|pullback|reversal|rebound|bounce|move|dip|run|spike|sell ?off|leg (?:up|down)|push (?:up|higher|down|lower))\b/i,
  },
  {
    category: 'market_call',
    reason: 'predicted market event',
    pattern:
      /\b(?:rally|breakout|break ?out|sell ?off|reversal|pull ?back|pullback|correction|bounce|crash|dip|move)\s+(?:is\s+)?(?:coming|incoming|ahead|imminent|on (?:its|the) way|brewing|loading|setting up|due)\b/i,
  },

  // ── Trade instructions ─────────────────────────────────────────────────────
  {
    category: 'trade_instruction',
    reason: 'recommendation to act on a position',
    pattern:
      /\b(?:you\s+(?:should|could|ought to|need to|might want to|may want to|'?d want to)|i(?:'?d| would)?\s+(?:recommend|suggest|advise)|my\s+(?:advice|recommendation)\s+is\s+to|it'?s\s+time\s+to|now(?:'?s| is)?\s+(?:a good time|the time)\s+to|consider|why not|go ahead and)\s+(?:buy|sell|close|open|short|long|exit|enter|add|scale|hedge|hold|take profit|cut|trim|load up|double down|average (?:in|down))\b/i,
  },
  {
    category: 'trade_instruction',
    reason: 'direct question turned instruction (should I buy/sell)',
    pattern: /\bshould\s+i\s+(?:buy|sell|close|hold|open|short|long|exit|enter)\b/i,
  },
  {
    category: 'trade_instruction',
    reason: 'buy/sell a named instrument',
    pattern: new RegExp(`\\b(?:buy|sell|short|long)\\s+(?:some\\s+|more\\s+|the\\s+)?${ASSET}\\b`, 'i'),
  },
  {
    category: 'trade_instruction',
    reason: 'buy/sell a currency pair',
    pattern: new RegExp(`\\b(?:buy|sell|short|long)\\s+${PAIR}\\b`),
  },
  {
    category: 'trade_instruction',
    reason: 'imperative trade action',
    pattern:
      /\b(?:buy|sell|short|long|exit|dump)\s+(?:now|immediately|today|asap|here|your|the|this|that|out|some|more|all|half)\b/i,
  },
  {
    category: 'trade_instruction',
    reason: 'instruction to close/open a position',
    pattern: /\b(?:close|open)\s+(?:out\s+)?(?:your|the|this|that|all|half|some)\b/i,
  },
  {
    category: 'trade_instruction',
    reason: 'directional instruction',
    pattern: /\bgo\s+(?:long|short)\b|\b(?:take|lock in)\s+(?:your\s+)?profits?\b|\bcut\s+(?:your\s+)?(?:losses|loss)\s+(?:now|here|today)\b|\bhold\s+(?:your\s+|onto\s+(?:your\s+)?)?positions?\b/i,
  },

  // ── Price predictions / targets ────────────────────────────────────────────
  {
    category: 'price_prediction',
    reason: 'price target language',
    pattern: /\b(?:price\s+target|target\s+price|\bpt\b|fair value of)\b/i,
  },
  {
    category: 'price_prediction',
    reason: 'predicted price level',
    pattern:
      /\b(?:will|would|could|should|gonna|going to|to|may|might)\s+(?:\w+\s+){0,2}?(?:hit|reach|reaches|test|retest|touch|tap|get to|run to|head to|climb to|drop to|fall to)\s+\$?\d/i,
  },
  {
    category: 'price_prediction',
    reason: 'target price/level',
    pattern:
      /\b(?:hit|reach|target(?:ing)?|headed to|heading to|on (?:its|the) way to|aiming for)\s+\$?\d[\d,.]*\s*[kKmM]?\b/i,
  },
  {
    category: 'price_prediction',
    reason: 'price by a date',
    pattern: /\$?\d[\d,.]*\s*[kKmM]?\s+by\s+(?:end of\s+)?(?:eo[dwmy]|next|this|the|monday|tuesday|wednesday|thursday|friday|q[1-4]|\d|\w+day|week|month|year|quarter)/i,
  },

  // ── Signals ────────────────────────────────────────────────────────────────
  {
    category: 'signal',
    reason: 'directional read on an instrument',
    pattern:
      /\blooks?\s+(?:strong|weak|bullish|bearish|toppy|heavy|ripe|primed|ready (?:to|for)|set to|good (?:to|for) (?:buy|enter|short|long))\b/i,
  },
  {
    category: 'signal',
    reason: 'buy/sell signal',
    pattern: /\b(?:strong|clear|solid)\s+(?:buy|sell)\b|\b(?:buy|sell|trade|trading|entry)\s+signals?\b/i,
  },
  {
    category: 'signal',
    reason: 'bullish/bearish stance',
    pattern: /\b(?:bullish|bearish)\s+(?:on|signal|setup|here|now|today|trend|momentum|bias)\b|\b(?:looking|i'?m)\s+(?:bullish|bearish)\b/i,
  },
  {
    category: 'signal',
    reason: 'entry/setup signal',
    pattern: /\b(?:good|great|nice|clean|prime)\s+(?:entry|setup|level to (?:buy|enter|short|long)|spot to (?:buy|enter))\b/i,
  },

  // ── Prompt-injection (defense in depth) ────────────────────────────────────
  {
    category: 'prompt_injection',
    reason: 'attempt to override instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.?!]*\b(?:your|all|the|any|previous|prior|above|earlier)\b[^.?!]*\b(?:instructions?|prompts?|rules?|guidelines?|directives?|guardrails?|restrictions?|system|constraints?|safety)\b/i,
  },
  {
    category: 'prompt_injection',
    reason: 'role/jailbreak attempt',
    pattern:
      /\byou are now\b|\bnew\s+(?:instructions?|system prompt|rules?)\s*:|\bsystem prompt\b|\bact as\b[^.?!]*\b(?:unrestricted|no rules|jailbroken|dan)\b|\bpretend\b[^.?!]*\bno (?:rules|restrictions|guardrails)\b/i,
  },
];

export interface RuleHit {
  readonly category: GuardrailCategory;
  readonly reason: string;
  readonly match: string;
}

/** Scan text against the deterministic rules. Returns the first hit, or null. */
export function scanRules(text: string): RuleHit | null {
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) {
      return { category: rule.category, reason: rule.reason, match: m[0] };
    }
  }
  return null;
}
