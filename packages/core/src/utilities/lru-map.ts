// Utility: a Map capped at `capacity` entries with least-recently-used
// eviction (Map iteration order is insertion order; a hit re-inserts the
// key). Used by long-lived access-layer memo caches so they cannot grow for
// the lifetime of the app.

export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error("LruMap capacity must be >= 1");
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }
}
