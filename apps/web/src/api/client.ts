import type { paths } from './schema.gen';
import type { House, Item, Snapshot } from './types';

export class ApiError extends Error {
  readonly status: number;
  /** The server's `detail` as one line of text, when it sent one. */
  readonly detail: string | null;
  /** `reason` of a 409 (data contract §8). */
  readonly reason: string | null;
  constructor(status: number, message: string, detail: string | null = null, reason?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.reason = reason ?? null;
    this.name = 'ApiError';
  }
}

type JsonOf<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': infer T } } } };
}
  ? T
  : never;

/** `detail` of an error body: a string, or FastAPI's `[{msg}]` list (422). */
function detailText(body: unknown): string | null {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d))
    return (
      d
        .map((e) => (e as { msg?: string }).msg ?? '')
        .filter(Boolean)
        .join('; ') || null
    );
  return null;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  if (!res.ok && res.status !== 304) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // not JSON (a proxy's error page)
    }
    const reason = (body as { reason?: unknown } | null)?.reason;
    throw new ApiError(
      res.status,
      `${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}`,
      detailText(body),
      typeof reason === 'string' ? reason : undefined,
    );
  }
  return res;
}

export async function getJson<P extends keyof paths>(
  path: P,
  signal?: AbortSignal,
): Promise<JsonOf<P>> {
  const res = await request(path, signal ? { signal } : {});
  return (await res.json()) as JsonOf<P>;
}

export type SnapshotResult =
  { notModified: true } | { notModified: false; snapshot: Snapshot; etag: string | null };

/**
 * GET /api/snapshot with If-None-Match. The browser cache is bypassed (`no-store`) so a 304 is
 * only ever the server's answer to our own ETag, never a cached body we would have to re-read.
 */
export async function fetchSnapshot(
  etag: string | null,
  signal?: AbortSignal,
): Promise<SnapshotResult> {
  const res = await request('/api/snapshot', {
    cache: 'no-store',
    headers: etag ? { 'If-None-Match': etag } : {},
    ...(signal ? { signal } : {}),
  });
  if (res.status === 304) return { notModified: true };
  return {
    notModified: false,
    snapshot: (await res.json()) as Snapshot,
    etag: res.headers.get('ETag'),
  };
}

/** GET /api/items/{id}; null when the item is gone (404). */
export async function fetchItem(id: string): Promise<Item | null> {
  try {
    const res = await request(`/api/items/${encodeURIComponent(id)}`, { cache: 'no-store' });
    return (await res.json()) as Item;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** GET /api/house; null when there is no usable layout (404). */
export async function fetchHouse(): Promise<{ house: House; etag: string | null } | null> {
  try {
    const res = await request('/api/house', { cache: 'no-store' });
    return { house: (await res.json()) as House, etag: unquoteEtag(res.headers.get('ETag')) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** POST /api/items/{id}/log: append `- YYYY-MM-DD text` under "## Maintenance log". */
export const postLogEntry = (id: string, text: string, date?: string) =>
  postJson<Item>(`/api/items/${encodeURIComponent(id)}/log`, date ? { text, date } : { text });

/** POST /api/items/adopt: give a `not_adopted` note its housebook_id. */
export const postAdopt = (path: string) => postJson<Item>('/api/items/adopt', { path });

export type AuthCheck = 'ok' | 'unauthorized' | 'unreachable';

/**
 * GET /api/me, only to tell an expired login from a server that is down (DESIGN 15.7). Behind
 * oauth2-proxy an expired session answers 401, or redirects to the login page, which `manual`
 * redirect mode shows as an opaque redirect instead of following it cross-origin.
 */
export async function checkAuth(): Promise<AuthCheck> {
  try {
    const res = await fetch('/api/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.type === 'opaqueredirect') return 'unauthorized';
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** ETags arrive quoted (`"abc"`, `W/"abc"`) in headers and bare in JSON bodies and events. */
export function unquoteEtag(etag: string | null | undefined): string | null {
  if (etag == null) return null;
  return etag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

export const sameEtag = (a: string | null | undefined, b: string | null | undefined) =>
  unquoteEtag(a) === unquoteEtag(b);
