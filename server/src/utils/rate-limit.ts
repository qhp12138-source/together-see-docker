export class BoundedSlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly maxKeys = 4096) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('Rate limiter maxKeys must be a positive integer');
  }

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (limit <= 0) return true;
    const recent = (this.buckets.get(key) || []).filter((time) => now - time < windowMs);
    const allowed = recent.length < limit;
    if (allowed) recent.push(now);

    // Refresh insertion order so the hard cap behaves as an LRU boundary.
    this.buckets.delete(key);
    this.buckets.set(key, recent);
    if (this.buckets.size > this.maxKeys) {
      for (const [bucketKey, times] of this.buckets.entries()) {
        if (bucketKey !== key && !times.some((time) => now - time < windowMs)) this.buckets.delete(bucketKey);
      }
    }
    while (this.buckets.size > this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
    return allowed;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }
}
