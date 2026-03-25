/**
 * An LRU cache with a byte-size budget.
 *
 * Extends `Map<string, string>` so it is a drop-in replacement wherever a
 * `Map<string, string>` is expected (PipelineContext.sourceCache, function
 * parameters in source-index / lsp-enrichment stages, etc.).
 *
 * Eviction policy: when a new entry would push `currentBytes` over
 * `maxBytes`, the *oldest* (least-recently-used) entry is evicted first,
 * and eviction continues until the new entry fits.  A single entry that
 * exceeds the budget on its own is still admitted (the cache will contain
 * exactly that one entry until the next insertion).
 *
 * "Recently used" is maintained by deleting and re-inserting on every
 * `get`, which keeps insertion order ≡ LRU order in V8's Map.
 */
export class ByteBudgetLRU extends Map<string, string> {
  private currentBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = 512 * 1024 * 1024 /* 512 MB */) {
    super();
    this.maxBytes = maxBytes;
  }

  override get(key: string): string | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      // Promote to most-recently-used by moving to the end of insertion order.
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: string, value: string): this {
    // Remove the existing entry (if any) and deduct its byte cost.
    const existing = super.get(key);
    if (existing !== undefined) {
      this.currentBytes -= Buffer.byteLength(existing, 'utf8');
      super.delete(key);
    }

    const bytes = Buffer.byteLength(value, 'utf8');

    // Evict oldest entries until there is room for the new value.
    while (this.currentBytes + bytes > this.maxBytes && this.size > 0) {
      const oldest = this.keys().next().value;
      if (oldest === undefined) break;
      const oldValue = super.get(oldest)!;
      this.currentBytes -= Buffer.byteLength(oldValue, 'utf8');
      super.delete(oldest);
    }

    super.set(key, value);
    this.currentBytes += bytes;
    return this;
  }

  override delete(key: string): boolean {
    const existing = super.get(key);
    if (existing !== undefined) {
      this.currentBytes -= Buffer.byteLength(existing, 'utf8');
      return super.delete(key);
    }
    return false;
  }

  override clear(): void {
    super.clear();
    this.currentBytes = 0;
  }

  /** Current total byte usage across all cached values. */
  get currentBytesUsed(): number {
    return this.currentBytes;
  }
}
