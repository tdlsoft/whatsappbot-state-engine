export interface LRUCache<K, V> {
  get(key: K): V | null;
  set(key: K, value: V): void;
  delete(key: K): void;
}

export function createLRUCache<K, V>(capacity: number): LRUCache<K, V> {
  const cache = new Map<K, V>();

  return {
    get(key: K): V | null {
      if (!cache.has(key)) return null;
      
      const val = cache.get(key)!;
      cache.delete(key);
      cache.set(key, val);
      return val;
    },
    set(key: K, value: V): void {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= capacity) {
        const leastRecentlyUsedKey = cache.keys().next().value;
        if (leastRecentlyUsedKey !== undefined) {
          cache.delete(leastRecentlyUsedKey);
        }
      }
      cache.set(key, value);
    },
    delete(key: K): void {
      cache.delete(key);
    }
  };
}
