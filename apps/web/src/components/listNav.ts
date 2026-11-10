/**
 * Arrow-key moves between the entries of a list view (List, Attention): put it on the view's
 * onKeyDown and `data-nav` on each entry. Tab works as usual; ↑/↓, Home and End move.
 */
import type { KeyboardEvent } from 'react';

export function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  const i = all.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? all.length - 1
        : e.key === 'ArrowDown'
          ? Math.min(all.length - 1, i + 1)
          : Math.max(0, i - 1);
  if (all[next]) {
    e.preventDefault();
    all[next].focus();
  }
}
