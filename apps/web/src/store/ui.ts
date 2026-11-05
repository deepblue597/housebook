/** UI state: view, plan style (2D/3D), floor, selection, search query and theme. */
import { create } from 'zustand';

export type View = 'plan' | 'list';
/** How the plan is drawn. 2D is the default and the accessible baseline (D15). */
export type PlanStyle = '2d' | '3d';
/** Why the 3D view is not showing although it was chosen (this session only). */
export type Scene3dIssue = 'context_lost' | 'load_failed' | null;
export type Theme = 'auto' | 'light' | 'dark';

export type Selection =
  { kind: 'item'; id: string } | { kind: 'room'; roomId: string; floorId: string } | null;

interface UiState {
  view: View;
  planStyle: PlanStyle;
  scene3dIssue: Scene3dIssue;
  /** The 3D view had keyboard focus when it stopped: the banner's button takes it (M2-02). */
  scene3dFocus: boolean;
  theme: Theme;
  floorId: string | null;
  selection: Selection;
  query: string;
  setView: (view: View) => void;
  /** Also shows the plan, and choosing 3D again retries after a context loss. */
  setPlanStyle: (style: PlanStyle) => void;
  /** `takeFocus`: focus was inside the 3D view, so move it to the fallback banner. */
  setScene3dIssue: (issue: Scene3dIssue, takeFocus?: boolean) => void;
  /** The banner has taken the focus handed over by setScene3dIssue. */
  clearScene3dFocus: () => void;
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
  planStyle: stored('housebook.planStyle', ['2d', '3d'], '2d'),
  scene3dIssue: null,
  scene3dFocus: false,
  theme: stored('housebook.theme', ['auto', 'light', 'dark'], 'auto'),
  floorId: null,
  selection: null,
  query: '',
  setView: (view) => {
    store('housebook.view', view);
    set({ view });
  },
  setPlanStyle: (planStyle) => {
    store('housebook.planStyle', planStyle);
    store('housebook.view', 'plan');
    set({ planStyle, view: 'plan', scene3dIssue: null, scene3dFocus: false });
  },
  setScene3dIssue: (scene3dIssue, takeFocus = false) =>
    set({ scene3dIssue, scene3dFocus: scene3dIssue !== null && takeFocus }),
  clearScene3dFocus: () => set({ scene3dFocus: false }),
  setTheme: (theme) => {
    store('housebook.theme', theme);
    set({ theme });
  },
  setFloor: (floorId) => set({ floorId }),
  select: (selection) => set({ selection }),
  setQuery: (query) => set({ query }),
}));
