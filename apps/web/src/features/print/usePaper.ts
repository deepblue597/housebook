import { useEffect } from 'react';

/**
 * A page made for paper (D44, D45): always the light theme, whatever the app's theme or the
 * OS setting, and its own tab title. Both are put back when the page goes away.
 */
export function usePaper(title: string): void {
  useEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = 'light';
    const previous = document.title;
    document.title = `${title} · Housebook`;
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
      document.title = previous;
    };
  }, [title]);
}
