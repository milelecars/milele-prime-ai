/**
 * Tiny in-memory TTL cache for connector reads.
 *
 * Stores the in-flight promise (not just the resolved value), so concurrent
 * calls for the same key coalesce into one upstream request. Rejected promises
 * are evicted immediately so failures are never cached.
 */
interface Entry {
  readonly expiresAt: number;
  readonly value: Promise<unknown>;
}

export class TtlCache {
  private readonly store = new Map<string, Entry>();

  getOrLoad<T>(key: string, loader: () => Promise<T>, ttlMs: number): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value as Promise<T>;
    }

    const value = loader();
    this.store.set(key, { expiresAt: now + ttlMs, value });

    // Evict on failure so the next call retries rather than serving a rejection.
    void value.catch(() => {
      const current = this.store.get(key);
      if (current && current.value === value) {
        this.store.delete(key);
      }
    });

    return value;
  }

  /** Drop a single key (or all keys if omitted). */
  invalidate(key?: string): void {
    if (key === undefined) this.store.clear();
    else this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}
