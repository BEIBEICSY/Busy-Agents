export function createScanCache(ttlMs = 3000) {
  let cache = null;

  return {
    get(now = Date.now()) {
      if (!cache || now - cache.at > ttlMs) return null;
      return cache.value;
    },
    set(value, now = Date.now()) {
      cache = { at: now, value };
      return value;
    },
    clear() {
      cache = null;
    }
  };
}
