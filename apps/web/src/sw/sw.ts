/**
 * The service worker (D47, DESIGN 15.11): keeps the app itself available without a connection.
 * Built to /sw.js by vite-plugin-sw.ts, which fills in `__HOUSEBOOK_SW__` (this build's files).
 *
 * - Install: save the app shell (index.html, scripts, styles, latin fonts, icons). Large parts
 *   that are only loaded on demand (3D, PDF.js) are saved the first time they are used.
 * - Page loads: network first; the saved index.html when the network fails, answers with an
 *   error or a redirect (an expired login whose provider may be unreachable), or takes longer
 *   than 3 s. URLs with `?signin` always go to the network (signing in again).
 * - `/api/*` is never touched: the app keeps its own copy of the data (store/offlineCache.ts).
 *
 * This file must not import anything the app imports, so it builds as one self-contained script.
 */
import {
  NAVIGATION_TIMEOUT_MS,
  isCacheable,
  isUsablePage,
  markCachedShell,
  routeOf,
} from './routes';

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface WorkerScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
}
declare const self: WorkerScope;
declare const __HOUSEBOOK_SW__: { version: string; precache: string[] };

const { version, precache } = __HOUSEBOOK_SW__;
const SHELL = `housebook-shell-${version}`;
const ASSETS = `housebook-assets-${version}`;
const OWN = /^housebook-(shell|assets)-/;
const INDEX = '/index.html';

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // `redirect: 'error'`: an expired login must not get the login page saved as the app.
      await cache.addAll(
        precache.map((url) => new Request(url, { cache: 'reload', redirect: 'error' })),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (OWN.test(name) && name !== SHELL && name !== ASSETS) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const route = routeOf(e.request, self.location.origin);
  if (route === 'page') e.respondWith(page(e.request));
  else if (route === 'asset') e.respondWith(asset(e.request));
  else if (route === 'static') e.respondWith(staticFile(e.request));
});

async function savedShell(): Promise<Response | null> {
  const res = await caches.match(INDEX, { cacheName: SHELL });
  if (!res) return null;
  return new Response(markCachedShell(await res.text()), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

async function page(req: Request): Promise<Response> {
  const network = fetch(req).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), NAVIGATION_TIMEOUT_MS);
  });
  const first = await Promise.race([network, slow]);
  clearTimeout(timer);
  if (first !== 'slow' && isUsablePage(first)) return first!;
  const shell = await savedShell();
  if (shell) return shell;
  // Nothing saved yet: whatever the network says, redirects included (the login page).
  return (await network) ?? Response.error();
}

async function asset(req: Request): Promise<Response> {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (isCacheable(res)) {
    const copy = res.clone();
    void caches.open(ASSETS).then((c) => c.put(req, copy));
  }
  return res;
}

async function staticFile(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    if (res.ok) return res;
    return (await caches.match(req, { cacheName: SHELL })) ?? res;
  } catch (err) {
    const hit = await caches.match(req, { cacheName: SHELL });
    if (hit) return hit;
    throw err;
  }
}
