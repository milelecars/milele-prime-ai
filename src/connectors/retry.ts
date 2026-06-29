import { NotFoundError, NotImplementedError, ValidationError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import { sleep } from '../lib/utils.js';

const log = childLogger('connector:retry');

export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Exponential growth factor between attempts. */
  readonly factor: number;
  /** Decide whether a given error is worth retrying. */
  readonly isRetryable: (err: unknown) => boolean;
}

/**
 * Default retry predicate: retry transient/upstream failures, but fail fast on
 * deterministic errors that will never succeed on retry.
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof NotImplementedError) return false;
  if (err instanceof ValidationError) return false;
  if (err instanceof NotFoundError) return false;
  return true;
}

/** Run `fn`, retrying with exponential backoff + jitter per the policy. */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= policy.maxAttempts || !policy.isRetryable(err)) {
        throw err;
      }
      const backoff = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * Math.pow(policy.factor, attempt - 1),
      );
      // Full jitter to avoid thundering-herd retries.
      const delay = Math.round(Math.random() * backoff);
      log.warn({ attempt, maxAttempts: policy.maxAttempts, delay }, 'Retrying after error');
      await sleep(delay);
    }
  }
}
