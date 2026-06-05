// TTL promise deduplicator (§14 rate-limit mitigation). Returns the same in-flight
// promise when a key is requested again within `ttlMs`, avoiding redundant API calls
// across overlapping or rapid sequential fetches.
//
// On promise settlement (success or failure) the entry is removed so the map never
// grows unbounded. This is intentionally NOT a persistent cache – stale data is
// never served; only inflight coalescing + a tiny settle-time window matters.

export class TtlMemoizer<K, V> {
  private cache = new Map<K, { promise: Promise<V>; expiresAt: number }>();
  constructor(private ttlMs: number) {}

  get(key: K, factory: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > now) return entry.promise;

    const promise = factory();
    this.cache.set(key, { promise, expiresAt: now + this.ttlMs });
    promise.then(
      () => this.cache.delete(key),
      () => this.cache.delete(key),
    );
    return promise;
  }
}
