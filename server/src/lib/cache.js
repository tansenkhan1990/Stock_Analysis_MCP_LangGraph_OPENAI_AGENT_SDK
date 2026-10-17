/**
 * Tiny in-process TTL cache with in-flight de-duplication.
 * Yahoo endpoints are aggressively rate limited, so every upstream call in
 * this app goes through here.
 */
const store = new Map();
const inFlight = new Map();

export const cache = {
  get(key) {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return hit.value;
  },

  set(key, value, ttlMs) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  },

  async wrap(key, ttlMs, producer) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  },

  clear(prefix = '') {
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  },
};
