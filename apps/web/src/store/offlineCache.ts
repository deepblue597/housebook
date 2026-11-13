/**
 * The app's own copy of the data for offline use (D47, DESIGN 15.11): the last snapshot shown,
 * and when it was last known to be current. Kept in Cache Storage (no size limit worth worrying
 * about, unlike localStorage), separate from the service worker's caches of the app itself.
 *
 * Every function fails quietly: no Cache Storage (an insecure origin, a private window) just
 * means no offline copy.
 */
import type { Snapshot } from '../api/types';

export const DATA_CACHE = 'housebook-data';
const SNAPSHOT_KEY = '/offline/snapshot.json';
const META_KEY = '/offline/meta.json';
/** Bumped if the stored shape ever changes; an older copy is then ignored. */
const FORMAT = 1;

interface Meta {
  format: number;
  /** When the data was last known to be current (ISO). */
  at: string;
}

export interface OfflineCopy {
  snapshot: Snapshot;
  at: Date;
}

/** The part of CacheStorage used here (tests pass a fake). */
export type CacheStorageLike = Pick<CacheStorage, 'open' | 'delete'>;

const storage = (): CacheStorageLike | null => (typeof caches === 'undefined' ? null : caches);

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

/** Keep `snapshot` (when given) and the time it was current. */
export async function saveOffline(
  snapshot: Snapshot | null,
  at: Date,
  store: CacheStorageLike | null = storage(),
): Promise<void> {
  if (!store) return;
  try {
    const cache = await store.open(DATA_CACHE);
    // Snapshot first: a meta without its snapshot is ignored, the other way round would date
    // old data as new.
    if (snapshot) await cache.put(SNAPSHOT_KEY, json(snapshot));
    await cache.put(META_KEY, json({ format: FORMAT, at: at.toISOString() } satisfies Meta));
  } catch {
    // quota, private mode: no offline copy
  }
}

export async function readOffline(
  store: CacheStorageLike | null = storage(),
): Promise<OfflineCopy | null> {
  if (!store) return null;
  try {
    const cache = await store.open(DATA_CACHE);
    const [snap, meta] = await Promise.all([cache.match(SNAPSHOT_KEY), cache.match(META_KEY)]);
    if (!snap || !meta) return null;
    const m = (await meta.json()) as Partial<Meta>;
    const at = new Date(m.at ?? '');
    if (m.format !== FORMAT || Number.isNaN(at.getTime())) return null;
    return { snapshot: (await snap.json()) as Snapshot, at };
  } catch {
    return null;
  }
}

/** Forget the copy (signing out, D47). */
export async function clearOffline(store: CacheStorageLike | null = storage()): Promise<void> {
  try {
    await store?.delete(DATA_CACHE);
  } catch {
    // nothing to clear
  }
}
