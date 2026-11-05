/**
 * Minimal router: `/i/<id>` is the item deep link printed on QR stickers (D16); everything else
 * is the home view. The URL follows the selected item and vice versa (back/forward work).
 */
import { type Selection, useUi } from '../store/ui';

const ITEM_PATH = /^\/i\/([^/]+)\/?$/u;

export function selectionFromPath(pathname: string): Selection {
  const m = ITEM_PATH.exec(pathname);
  if (!m) return null;
  try {
    return { kind: 'item', id: decodeURIComponent(m[1]!) };
  } catch {
    return null;
  }
}

export const itemPath = (id: string): string => `/i/${encodeURIComponent(id)}`;

const pathFor = (s: Selection, current: string): string =>
  s?.kind === 'item' ? itemPath(s.id) : ITEM_PATH.test(current) ? '/' : current;

export function startRouter(): () => void {
  const ui = useUi.getState();
  ui.select(selectionFromPath(location.pathname));

  let fromHistory = false;
  const onPop = () => {
    fromHistory = true;
    useUi.getState().select(selectionFromPath(location.pathname));
    fromHistory = false;
  };
  window.addEventListener('popstate', onPop);

  const unsubscribe = useUi.subscribe((state, prev) => {
    if (state.selection === prev.selection || fromHistory) return;
    const next = pathFor(state.selection, location.pathname);
    if (next !== location.pathname) history.pushState(null, '', next + location.search);
  });

  return () => {
    window.removeEventListener('popstate', onPop);
    unsubscribe();
  };
}
