/**
 * Production wiring for the hardening cross-cuts (Redis-backed so the kill
 * switch and cost counters are shared across the web + worker processes).
 * Kept out of the pure ops modules so they stay testable offline.
 */
import { bot } from '../bot/bot.js';
import { env } from '../config/env.js';
import { childLogger } from '../lib/logger.js';
import { toError } from '../lib/utils.js';
import { redisConnection } from '../queue/connection.js';
import {
  CostTracker,
  DEFAULT_COST_RATES,
  RedisCostStore,
  RedisHaltGate,
  SlidingWindowRateLimiter,
  type CostAlert,
  type CostAlertNotifier,
  type CostCeilings,
} from './index.js';

const log = childLogger('ops');

let halt: RedisHaltGate | undefined;
/** Shared, Redis-backed kill switch. */
export function haltGate(): RedisHaltGate {
  halt ??= new RedisHaltGate(redisConnection);
  return halt;
}

/** Seed the halt flag from `SYSTEM_HALT` at startup. */
export async function seedHalt(): Promise<void> {
  if (env.SYSTEM_HALT) await haltGate().set(true);
}

export function createRateLimiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(env.INBOUND_RATE_MAX, env.INBOUND_RATE_WINDOW_MS);
}

export function costCeilings(): CostCeilings {
  return {
    userDailyUsd: env.COST_USER_DAILY_USD,
    tierMultipliers: { bronze: 1, silver: 1.5, gold: 2.5, platinum: 5 },
    globalDailyUsd: env.COST_GLOBAL_DAILY_USD,
  };
}

const costNotifier: CostAlertNotifier = {
  async notify(alert: CostAlert): Promise<void> {
    log.error({ ...alert }, 'Global daily cost threshold crossed');
    if (env.ESCALATION_CHAT_ID !== undefined) {
      await bot.api
        .sendMessage(
          env.ESCALATION_CHAT_ID,
          `💸 Global daily spend $${alert.globalUsd.toFixed(2)} crossed the $${alert.thresholdUsd} threshold (${alert.day}).`,
        )
        .catch((err) => log.error({ err: toError(err) }, 'Failed to post cost alert'));
    }
  },
};

export function createCostTracker(): CostTracker {
  return new CostTracker(
    new RedisCostStore(redisConnection),
    DEFAULT_COST_RATES,
    costCeilings(),
    costNotifier,
    { now: () => Date.now() },
  );
}
