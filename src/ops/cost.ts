/**
 * Cost monitoring. Tracks per-user and global daily spend across LLM tokens,
 * TTS characters, and STT minutes (normalized to USD via configurable rates).
 *
 * - Alerts (log + internal notification) when the global daily threshold is
 *   crossed (once per day).
 * - Enforces a per-user daily hard ceiling (tier-scaled); when hit, the inbound
 *   pipeline triggers the graceful exit early for that user for the rest of the
 *   day.
 */
import type { Redis } from 'ioredis';
import type { AccountTier } from '../connectors/brokeret/types.js';

export interface CostRates {
  /** USD per LLM token (input + output blended). */
  readonly perLlmToken: number;
  /** USD per TTS character. */
  readonly perTtsChar: number;
  /** USD per STT minute. */
  readonly perSttMinute: number;
}

export interface CostCeilings {
  /** Per-user daily ceiling (USD), scaled by tier multiplier. */
  readonly userDailyUsd: number;
  readonly tierMultipliers: Readonly<Record<AccountTier, number>>;
  /** Global daily alert threshold (USD). */
  readonly globalDailyUsd: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  perLlmToken: 0.00001, // ~$10 / 1M tokens (blended Opus)
  perTtsChar: 0.0002,
  perSttMinute: 0.006,
};

export interface CostAlert {
  readonly day: string;
  readonly globalUsd: number;
  readonly thresholdUsd: number;
}

export interface CostAlertNotifier {
  notify(alert: CostAlert): Promise<void> | void;
}

/** Persistence for daily cost counters. In-memory for tests; Redis for prod. */
export interface CostStore {
  addUserCost(crmClientId: string, day: string, usd: number): Promise<number>;
  getUserCost(crmClientId: string, day: string): Promise<number>;
  addGlobalCost(day: string, usd: number): Promise<number>;
  /** Atomically mark the global alert for `day` as sent; true if newly marked. */
  markGlobalAlerted(day: string): Promise<boolean>;
}

export class InMemoryCostStore implements CostStore {
  private readonly user = new Map<string, number>();
  private readonly global = new Map<string, number>();
  private readonly alerted = new Set<string>();

  async addUserCost(crmClientId: string, day: string, usd: number): Promise<number> {
    const key = `${crmClientId}:${day}`;
    const next = (this.user.get(key) ?? 0) + usd;
    this.user.set(key, next);
    return next;
  }
  async getUserCost(crmClientId: string, day: string): Promise<number> {
    return this.user.get(`${crmClientId}:${day}`) ?? 0;
  }
  async addGlobalCost(day: string, usd: number): Promise<number> {
    const next = (this.global.get(day) ?? 0) + usd;
    this.global.set(day, next);
    return next;
  }
  async markGlobalAlerted(day: string): Promise<boolean> {
    if (this.alerted.has(day)) return false;
    this.alerted.add(day);
    return true;
  }
}

/** Redis-backed cost store (shared across processes; day-keyed with TTL). */
export class RedisCostStore implements CostStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 3 * 24 * 60 * 60,
  ) {}
  private async incr(key: string, usd: number): Promise<number> {
    const total = await this.redis.incrbyfloat(key, usd);
    await this.redis.expire(key, this.ttlSeconds);
    return Number(total);
  }
  addUserCost(crmClientId: string, day: string, usd: number): Promise<number> {
    return this.incr(`milele:cost:u:${crmClientId}:${day}`, usd);
  }
  async getUserCost(crmClientId: string, day: string): Promise<number> {
    return Number((await this.redis.get(`milele:cost:u:${crmClientId}:${day}`)) ?? 0);
  }
  addGlobalCost(day: string, usd: number): Promise<number> {
    return this.incr(`milele:cost:g:${day}`, usd);
  }
  async markGlobalAlerted(day: string): Promise<boolean> {
    const set = await this.redis.set(`milele:cost:alert:${day}`, '1', 'EX', this.ttlSeconds, 'NX');
    return set === 'OK';
  }
}

function dayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class CostTracker {
  constructor(
    private readonly store: CostStore,
    private readonly rates: CostRates,
    private readonly ceilings: CostCeilings,
    private readonly notifier: CostAlertNotifier,
    private readonly clock: { now(): number },
  ) {}

  private async record(crmClientId: string, usd: number): Promise<void> {
    if (usd <= 0) return;
    const day = dayOf(this.clock.now());
    await this.store.addUserCost(crmClientId, day, usd);
    const globalTotal = await this.store.addGlobalCost(day, usd);
    if (globalTotal >= this.ceilings.globalDailyUsd && (await this.store.markGlobalAlerted(day))) {
      await this.notifier.notify({ day, globalUsd: globalTotal, thresholdUsd: this.ceilings.globalDailyUsd });
    }
  }

  recordLlmTokens(crmClientId: string, tokens: number): Promise<void> {
    return this.record(crmClientId, tokens * this.rates.perLlmToken);
  }
  recordTtsChars(crmClientId: string, chars: number): Promise<void> {
    return this.record(crmClientId, chars * this.rates.perTtsChar);
  }
  recordSttMinutes(crmClientId: string, minutes: number): Promise<void> {
    return this.record(crmClientId, minutes * this.rates.perSttMinute);
  }

  /** Per-user daily ceiling for a tier (USD). */
  userCeiling(tier: AccountTier): number {
    return this.ceilings.userDailyUsd * (this.ceilings.tierMultipliers[tier] ?? 1);
  }

  /** True if the user has hit their tier-scaled daily ceiling. */
  async isUserOverCeiling(crmClientId: string, tier: AccountTier): Promise<boolean> {
    const day = dayOf(this.clock.now());
    const spent = await this.store.getUserCost(crmClientId, day);
    return spent >= this.userCeiling(tier);
  }
}
