/** Per-session budget: tier-scaled caps and the three behavior bands. */
import type { AccountTier } from '../connectors/brokeret/types.js';
import type { BudgetBand, BudgetConfig } from './types.js';

export interface BudgetCaps {
  readonly maxExchanges: number;
  readonly maxTokens: number;
}

export function capsForTier(config: BudgetConfig, tier: AccountTier): BudgetCaps {
  const mult = config.tierMultipliers[tier] ?? 1;
  return {
    maxExchanges: Math.max(1, Math.round(config.baseExchanges * mult)),
    maxTokens: Math.max(1, Math.round(config.baseTokens * mult)),
  };
}

/** Fraction of budget consumed (0..1+), the max of the exchange and token ratios. */
export function budgetRatio(
  caps: BudgetCaps,
  exchangeCount: number,
  tokenCount: number,
): number {
  return Math.max(exchangeCount / caps.maxExchanges, tokenCount / caps.maxTokens);
}

/** Map a consumed ratio to a behavior band. */
export function bandForRatio(ratio: number): BudgetBand {
  if (ratio >= 1) return 'cap';
  if (ratio >= 0.7) return 'tighten';
  return 'normal';
}

/** Rough, dependency-free token estimate (≈ 4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
