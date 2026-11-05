/**
 * Server data: one /api/snapshot, revalidated with If-None-Match when the window regains focus
 * (DESIGN 15.7: polling the snapshot is the fallback sync path; SSE arrives in milestone 4).
 */
import { create } from 'zustand';
import { fetchSnapshot } from '../api/client';
import { type Model, buildModel } from './model';

export type LoadState = 'loading' | 'ready' | 'error';

interface DataState {
  state: LoadState;
  model: Model | null;
  etag: string | null;
  /** Last failure; with a model present it means "showing older data". */
  error: string | null;
  loadedAt: Date | null;
  load: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useData = create<DataState>()((set, get) => ({
  state: 'loading',
  model: null,
  etag: null,
  error: null,
  loadedAt: null,
  load: () => {
    inflight ??= (async () => {
      try {
        const res = await fetchSnapshot(get().etag);
        if (res.notModified) {
          set({ error: null, loadedAt: new Date() });
        } else {
          set({
            state: 'ready',
            model: buildModel(res.snapshot),
            etag: res.etag,
            error: null,
            loadedAt: new Date(),
          });
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        set((s) => ({ error, state: s.model ? 'ready' : 'error' }));
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));

/** Refetch when the tab becomes visible or the window regains focus. */
export function revalidateOnFocus(): () => void {
  const refresh = () => {
    if (document.visibilityState === 'visible') void useData.getState().load();
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}
