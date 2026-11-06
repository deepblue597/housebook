/**
 * Server data: one /api/snapshot, kept current by the live sync client (store/sync.ts) with
 * single-item updates from server-sent events (data contract §9), and the app's own writes.
 *
 * Everything that changes the data (snapshot loads, event handling, writes) runs through one
 * queue, in order. So a snapshot that was requested before an event can't overwrite what the
 * event brought, and an event announcing the app's own write is looked at only after the
 * write's response is in: its etag then equals the held one and it is ignored (no refetch).
 */
import { create } from 'zustand';
import {
  ApiError,
  fetchHouse,
  fetchItem,
  fetchSnapshot,
  getJson,
  postAdopt,
  postLogEntry,
  sameEtag,
} from '../api/client';
import type {
  House,
  HouseChangedEvent,
  Item,
  ItemChangedEvent,
  ItemDeletedEvent,
  Me,
  ProblemsChangedEvent,
  ResyncEvent,
  Snapshot,
} from '../api/types';
import { type Model, buildModel } from './model';

export type LoadState = 'loading' | 'ready' | 'error';
/** How a snapshot load went; `unauthorized` means the login expired (the sync client reloads). */
export type LoadResult = 'ok' | 'unauthorized' | 'failed';

interface DataState {
  state: LoadState;
  model: Model | null;
  /**
   * ETag of the snapshot the model was built from. Null once single-item updates have been
   * applied on top: the held data is then newer than any snapshot ETag we know.
   */
  etag: string | null;
  /** `itemsVersion` of the held items; null when unknown (after single-item updates). */
  itemsVersion: string | null;
  /** Last failure; with a model present it means "showing older data". */
  error: string | null;
  loadedAt: Date | null;
  /** Integrity report size: from the snapshot, `resync` and `problems.changed`. */
  problemCount: number;
  /** Bumped whenever the integrity report may have changed (an open panel refetches). */
  problemsRev: number;
  /** Current user and role; null until known (no write UI until then). */
  me: Me | null;
  load: () => Promise<LoadResult>;
  loadMe: () => Promise<void>;
  // Live sync (store/sync.ts feeds these).
  resync: (e: ResyncEvent) => Promise<void>;
  houseChanged: (e: HouseChangedEvent) => Promise<void>;
  itemChanged: (e: ItemChangedEvent) => Promise<void>;
  itemDeleted: (e: ItemDeletedEvent) => Promise<void>;
  problemsChanged: (e: ProblemsChangedEvent) => void;
  // Writes (editors only; the server checks the role too).
  appendLog: (id: string, text: string, date?: string) => Promise<Item>;
  adopt: (path: string) => Promise<Item>;
}

// ---- the queue ------------------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/** A plain load() (first load, focus, polling) shares one that is queued or running. */
let sharedLoad: Promise<LoadResult> | null = null;

/** Where each item stands, as the server derives it (indexer `_location`): first placement. */
export function relocate(items: readonly Item[], house: House | null): Item[] {
  const placements = new Map<string, NonNullable<House['placements']>[number]>();
  for (const p of house?.placements ?? [])
    if (!placements.has(p.itemId)) placements.set(p.itemId, p);
  const floors = new Map((house?.floors ?? []).map((f) => [f.id, f]));
  return items.map((item) => {
    const p = placements.get(item.id);
    const location = p
      ? {
          floorId: p.floorId,
          roomId: floors.get(p.floorId)?.cells?.[`${p.x},${p.y}`] ?? null,
          x: p.x,
          y: p.y,
          rotation: p.rotation ?? 0,
        }
      : null;
    const same =
      location === item.location ||
      (!!location &&
        !!item.location &&
        location.floorId === item.location.floorId &&
        location.roomId === item.location.roomId &&
        location.x === item.location.x &&
        location.y === item.location.y &&
        location.rotation === item.location.rotation);
    return same ? item : { ...item, location };
  });
}

/** The dedupe rule of data contract §9: nothing to fetch if all four match what is held. */
export function itemIsCurrent(held: Item | undefined, e: ItemChangedEvent): boolean {
  return (
    !!held &&
    sameEtag(held.etag, e.etag) &&
    held.path === e.path &&
    held.stale === e.stale &&
    held.attachmentsEtag === e.attachmentsEtag
  );
}

export const useData = create<DataState>()((set, get) => {
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** One snapshot request; call only from inside the queue. */
  const loadNow = async (): Promise<LoadResult> => {
    try {
      const res = await fetchSnapshot(get().etag);
      if (res.notModified) {
        set({ error: null, loadedAt: new Date() });
      } else {
        set({
          state: 'ready',
          model: buildModel(res.snapshot),
          etag: res.etag,
          itemsVersion: res.snapshot.itemsVersion,
          problemCount: res.snapshot.problemCount,
          error: null,
          loadedAt: new Date(),
        });
      }
      return 'ok';
    } catch (e) {
      set((s) => ({ error: errorText(e), state: s.model ? 'ready' : 'error' }));
      return e instanceof ApiError && e.status === 401 ? 'unauthorized' : 'failed';
    }
  };

  /** Replace the held snapshot with an edited copy (single-item or layout updates). */
  const commit = (snapshot: Snapshot, itemsChanged: boolean) =>
    set((s) => ({
      model: buildModel(snapshot),
      etag: null,
      itemsVersion: itemsChanged ? null : s.itemsVersion,
      loadedAt: new Date(),
    }));

  const upsert = (item: Item) => {
    const snap = get().model?.snapshot;
    if (!snap) return;
    const items = snap.items.some((i) => i.id === item.id)
      ? snap.items.map((i) => (i.id === item.id ? item : i))
      : [...snap.items, item];
    commit({ ...snap, items }, true);
  };

  const remove = (id: string) => {
    const snap = get().model?.snapshot;
    if (!snap || !snap.items.some((i) => i.id === id)) return;
    commit({ ...snap, items: snap.items.filter((i) => i.id !== id) }, true);
  };

  /** house.json changed: fetch just the layout, or the snapshot when more than that changed. */
  const houseNow = async (etag: string | null, readOnly: boolean) => {
    const snap = get().model?.snapshot;
    if (!snap) return;
    if (sameEtag(etag, snap.houseEtag) && readOnly === snap.houseReadOnly) return;
    // Missing, unreadable or newly (not) read-only: the snapshot also carries the schema
    // version and keeps the last valid layout, so take all of it.
    if (etag === null || readOnly !== snap.houseReadOnly) {
      await loadNow();
      return;
    }
    const res = await fetchHouse();
    if (!res) {
      await loadNow();
      return;
    }
    const now = get().model?.snapshot ?? snap;
    commit(
      {
        ...now,
        house: res.house,
        houseEtag: res.etag ?? etag,
        houseSchemaVersion: res.house.schemaVersion,
        items: relocate(now.items, res.house),
      },
      false,
    );
  };

  const swallow = (e: unknown) => {
    // A failed refetch leaves the held data; the next resync, poll or focus catches up.
    set({ error: errorText(e) });
  };

  return {
    state: 'loading',
    model: null,
    etag: null,
    itemsVersion: null,
    error: null,
    loadedAt: null,
    problemCount: 0,
    problemsRev: 0,
    me: null,

    load: () => {
      sharedLoad ??= enqueue(loadNow).finally(() => {
        sharedLoad = null;
      });
      return sharedLoad;
    },

    loadMe: async () => {
      try {
        set({ me: await getJson('/api/me') });
      } catch {
        set({ me: null });
      }
    },

    resync: (e) =>
      enqueue(async () => {
        set((s) => ({ problemCount: e.problemCount, problemsRev: s.problemsRev + 1 }));
        const { model, itemsVersion } = get();
        if (!model || itemsVersion !== e.itemsVersion) {
          await loadNow();
          return;
        }
        await houseNow(e.houseEtag, e.houseReadOnly);
      }).catch(swallow),

    houseChanged: (e) => enqueue(() => houseNow(e.etag, e.readOnly)).catch(swallow),

    itemChanged: (e) =>
      enqueue(async () => {
        const model = get().model;
        if (!model || itemIsCurrent(model.items.get(e.id), e)) return;
        const item = await fetchItem(e.id);
        if (item) upsert(item);
        else remove(e.id);
      }).catch(swallow),

    itemDeleted: (e) =>
      enqueue(() => {
        remove(e.id);
        return Promise.resolve();
      }).catch(swallow),

    problemsChanged: (e) => set((s) => ({ problemCount: e.count, problemsRev: s.problemsRev + 1 })),

    appendLog: (id, text, date) =>
      enqueue(async () => {
        const item = await postLogEntry(id, text, date);
        upsert(item);
        return item;
      }),

    adopt: (path) =>
      enqueue(async () => {
        const item = await postAdopt(path);
        upsert(item);
        set((s) => ({ problemsRev: s.problemsRev + 1 }));
        return item;
      }),
  };
});
