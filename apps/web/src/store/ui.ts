/** UI state: view, floor, selection, search query and theme. */
import { create } from 'zustand';

export type View = 'plan' | 'list';
export type Theme = 'auto' | 'light' | 'dark';

export type Selection =
  { kind: 'item'; id: string } | { kind: 'room'; roomId: string; floorId: string } | null;

interface UiState {
  view: View;
  theme: Theme;
  floorId: string | null;
  selection: Selection;
  query: string;
  setView: (view: View) => void;
  setTheme: (theme: Theme) => void;
  setFloor: (floorId: string) => void;
  select: (selection: Selection) => void;
  setQuery: (query: string) => void;
}

// Per-browser conveniences only; storage may be unavailable (private mode, blocked cookies).
const stored = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

export const useUi = create<UiState>()((set) => ({
  view: stored('housebook.view', ['plan', 'list'], 'plan'),
  theme: stored('housebook.theme', ['auto', 'light', 'dark'], 'auto'),
  floorId: null,
  selection: null,
  query: '',
  setView: (view) => {
    store('housebook.view', view);
    set({ view });
  },
  setTheme: (theme) => {
    store('housebook.theme', theme);
    set({ theme });
  },
  setFloor: (floorId) => set({ floorId }),
  select: (selection) => set({ selection }),
  setQuery: (query) => set({ query }),
}));
