import type { CacheStorageLike } from '../store/offlineCache';

/** Cache Storage in memory: enough of it for offlineCache.ts. */
export function fakeCaches(): CacheStorageLike & { names: () => string[] } {
  const stores = new Map<string, Map<string, string>>();
  return {
    names: () => [...stores.keys()],
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return Promise.resolve({
        put: async (key: string, res: Response) => void store.set(key, await res.text()),
        match: (key: string) => {
          const body = store.get(key);
          return Promise.resolve(body === undefined ? undefined : new Response(body));
        },
      } as unknown as Cache);
    },
    delete: (name: string) => Promise.resolve(stores.delete(name)),
  };
}
