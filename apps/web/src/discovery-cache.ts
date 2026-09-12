/** Small TTL cache that coalesces expensive concurrent fleet discovery. */
export class DiscoveryCache<T> {
  private readonly entries = new Map<string, { fingerprint: string; expiresAt: number; value?: T; pending?: Promise<T> }>();

  async get(key: string, fingerprint: string, load: () => Promise<T>, ttlMs = 15_000): Promise<T> {
    const now = Date.now();
    const current = this.entries.get(key);
    if (current && current.fingerprint === fingerprint && current.expiresAt > now) {
      if (current.value !== undefined) return current.value;
      if (current.pending) return current.pending;
    }
    const entry: { fingerprint: string; expiresAt: number; value?: T; pending?: Promise<T> } = { fingerprint, expiresAt: now + ttlMs };
    const pending = load().then((value) => {
      entry.value = value;
      entry.pending = undefined;
      return value;
    }).catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    entry.pending = pending;
    this.entries.set(key, entry);
    return pending;
  }

  clear(): void { this.entries.clear(); }
}
