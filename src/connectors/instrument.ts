import type { TtlCache } from './cache.js';
import { withRetry, type RetryPolicy } from './retry.js';

export interface InstrumentOptions {
  /** Namespace for cache keys (e.g. `mt5`, `brokeret`). */
  readonly name: string;
  readonly retry: RetryPolicy;
  readonly cache: TtlCache;
  /** Default cache TTL in ms. Use 0 to disable caching entirely. */
  readonly defaultTtlMs: number;
  /** Optional per-method TTL overrides (ms). 0 disables caching for a method. */
  readonly ttls?: Readonly<Record<string, number>>;
}

/** Stable cache key from method name + primitive arguments. */
function argKey(args: readonly unknown[]): string {
  return args
    .map((a) => (a instanceof Date ? a.toISOString() : JSON.stringify(a) ?? 'undefined'))
    .join('|');
}

/**
 * Wrap a connector implementation with retry-with-backoff and a short-TTL
 * cache, transparently — the returned object satisfies the same interface `T`,
 * so callers depend only on the interface and never on this wrapper.
 *
 * Every method call is routed through `cache.getOrLoad(key, () => withRetry(...))`.
 * Non-function members pass through untouched.
 */
export function instrument<T extends object>(impl: T, options: InstrumentOptions): T {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver) as unknown;
      if (typeof member !== 'function' || typeof prop === 'symbol') {
        return member;
      }
      const method = prop;
      const fn = member as (...args: unknown[]) => Promise<unknown>;

      return (...args: unknown[]): Promise<unknown> => {
        const run = (): Promise<unknown> => withRetry(() => fn.apply(target, args), options.retry);

        const ttl = options.ttls?.[method] ?? options.defaultTtlMs;
        if (ttl <= 0) return run();

        const key = `${options.name}.${method}:${argKey(args)}`;
        return options.cache.getOrLoad(key, run, ttl);
      };
    },
  }) as T;
}
