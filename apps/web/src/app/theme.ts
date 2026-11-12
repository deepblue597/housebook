/** Light/dark theme: follows the OS unless the user picked one (applied as `data-theme`). */
import { useEffect, useSyncExternalStore } from 'react';
import { useUi } from '../store/ui';

/** Ink and paper per theme; must match the tokens in styles/app.css. */
export const PALETTE = {
  light: { ink: '#1A262B', paper: '#F9FBFA', tileOpacity: 0.32 },
  dark: { ink: '#E0E9E7', paper: '#151E22', tileOpacity: 0.4 },
} as const;

const query = '(prefers-color-scheme: dark)';
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia?.(query);
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
};
const prefersDark = () => window.matchMedia?.(query).matches ?? false;

export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useUi((s) => s.theme);
  const osDark = useSyncExternalStore(subscribe, prefersDark, () => false);
  return theme === 'auto' ? (osDark ? 'dark' : 'light') : theme;
}

export function useApplyTheme(): void {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}
