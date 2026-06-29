/**
 * Per-user inbound rate limiting to stop spam/abuse. Sliding window; excess
 * messages get a soft throttle response (the caller decides), never a crash.
 */
export interface RateLimiter {
  /** Returns true if the action is allowed (and records it), false if throttled. */
  check(key: string, nowMs: number): boolean;
}

export const THROTTLE_MESSAGE = 'Give me a sec — you’re sending those faster than I can think. I’ll catch up in a moment.';

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, nowMs: number): boolean {
    const cutoff = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.max) {
      this.hits.set(key, recent); // keep pruned window; do not record the blocked hit
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}
