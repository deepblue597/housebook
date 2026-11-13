/**
 * What the service worker (sw.ts, D47) does with a request. Pure, so it is unit-tested; sw.ts
 * only wires it to the Cache and fetch APIs.
 */

/** Added to a URL to get past the service worker to the login proxy (`reloadForAuth`). */
export const SIGNIN_PARAM = 'signin';

/** How long a page load waits for the network before showing the saved app (DESIGN 15.11). */
export const NAVIGATION_TIMEOUT_MS = 3_000;

export type Route =
  /** Not ours to answer: the browser fetches it as if there were no service worker. */
  | 'network'
  /** A page load: network first, the saved app if that fails, redirects or is slow. */
  | 'page'
  /** A content-hashed build file: it never changes, so the saved copy is always right. */
  | 'asset'
  /** Another file of the app (icons, manifest): network first, saved copy offline. */
  | 'static';

export function routeOf(req: { method: string; mode: string; url: string }, origin: string): Route {
  if (req.method !== 'GET') return 'network';
  const url = new URL(req.url);
  if (url.origin !== origin) return 'network';
  // Data, live events and health checks always go to the server; the app keeps its own copy
  // of the data for offline use (store/offlineCache.ts).
  if (/^\/(api(\/|$)|healthz$|readyz$)/.test(url.pathname)) return 'network';
  if (req.mode === 'navigate') return url.searchParams.has(SIGNIN_PARAM) ? 'network' : 'page';
  if (url.pathname.startsWith('/assets/')) return 'asset';
  if (url.pathname === '/sw.js') return 'network';
  return 'static';
}

/**
 * A page load's network answer is used only when it is a real page: not an error, and not a
 * redirect (to the login provider, which may be down or out of reach, DESIGN 15.11).
 * A `manual` redirect arrives as an `opaqueredirect` response with status 0, so `ok` covers it.
 */
export const isUsablePage = (res: { ok: boolean } | null | undefined): boolean => !!res?.ok;

/** Mark the saved app so it knows it wasn't loaded from the server (`shellFromCache`). */
export const markCachedShell = (html: string): string =>
  html.replace(/<html(\s|>)/i, '<html data-shell="cached"$1');

/** A response worth keeping: a plain same-origin 200 that wasn't redirected anywhere. */
export const isCacheable = (res: { ok: boolean; redirected: boolean; type: string }): boolean =>
  res.ok && !res.redirected && res.type === 'basic';
