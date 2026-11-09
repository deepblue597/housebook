/**
 * Unsaved note edits, by item id (D31). A draft outlives the details panel: closing it or
 * opening another item keeps the edit, and the item reopens in the editor. Only a save, Cancel
 * or a page reload ends it (the page warns before unloading while a draft has changes).
 */
import { create } from 'zustand';
import { type NoteDraft, changedKeys } from './noteForm';

interface DraftsState {
  drafts: Readonly<Record<string, NoteDraft>>;
  put: (id: string, draft: NoteDraft) => void;
  drop: (id: string) => void;
}

export const useDrafts = create<DraftsState>()((set) => ({
  drafts: {},
  put: (id, draft) => set((s) => ({ drafts: { ...s.drafts, [id]: draft } })),
  drop: (id) =>
    set((s) => {
      if (!(id in s.drafts)) return s;
      const rest = { ...s.drafts };
      delete rest[id];
      return { drafts: rest };
    }),
}));

export const hasUnsavedDrafts = (): boolean =>
  Object.values(useDrafts.getState().drafts).some((d) => changedKeys(d).length > 0);

if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedDrafts()) e.preventDefault();
  });
