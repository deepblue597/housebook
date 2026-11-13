/**
 * The installable, offline-capable app (D47, DESIGN 15.11): service worker registration, and
 * how the page tells it was started from the saved copy of the app.
 */
// Also in sw/routes.ts (a test checks they match): an import would make the service worker
// share a chunk with the app, and it must build as one self-contained file.
export const SIGNIN_PARAM = 'signin';

/** Production builds only: in `pnpm dev` a service worker would serve stale code. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () =>
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // No service worker (insecure origin, blocked): the app works online as before.
    });
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
  // Installed to the home screen: ask the browser not to evict the offline copy (iOS clears
  // a site's storage after about a week without use otherwise). Not in a browser tab, where
  // Firefox would ask the user about it on the first visit.
  if (window.matchMedia?.('(display-mode: standalone)').matches)
    void navigator.storage?.persist?.().catch(() => false);
}

/**
 * True when the service worker answered this page load with its saved copy of the app: the
 * server couldn't be reached, was slow, or sent the browser to the login provider.
 */
export const shellFromCache = (): boolean => document.documentElement.dataset.shell === 'cached';

/** The current page with `?signin`, which the service worker lets through to the login proxy. */
export function signinUrl(href = window.location.href): string {
  const url = new URL(href);
  url.searchParams.set(SIGNIN_PARAM, '1');
  return url.toString();
}

/** Back from signing in: drop `?signin` from the address (before the router reads it). */
export function dropSigninParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SIGNIN_PARAM)) return;
  url.searchParams.delete(SIGNIN_PARAM);
  window.history.replaceState(window.history.state, '', url.toString());
}
