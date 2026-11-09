import type { paths } from './schema.gen';
import type { House, Item, ItemCreate, ItemPatch, Snapshot } from './types';

export class ApiError extends Error {
  readonly status: number;
  /** The server's `detail` as one line of text, when it sent one. */
  readonly detail: string | null;
  /** `reason` of a 409 (data contract §8). */
  readonly reason: string | null;
  /** The issues of a 422 (`{loc, msg}`), e.g. `loc: ["body", "frontmatter", "manual"]`. */
  readonly issues: readonly ApiIssue[];
  constructor(
    status: number,
    message: string,
    detail: string | null = null,
    reason?: string,
    issues: readonly ApiIssue[] = [],
  ) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.reason = reason ?? null;
    this.issues = issues;
    this.name = 'ApiError';
  }
}

export interface ApiIssue {
  loc: readonly (string | number)[];
  msg: string;
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

function issuesOf(body: unknown): ApiIssue[] {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (!Array.isArray(d)) return [];
  return d.flatMap((e) => {
    const { loc, msg } = (e ?? {}) as { loc?: unknown; msg?: unknown };
    return Array.isArray(loc) && typeof msg === 'string' ? [{ loc, msg }] : [];
  });
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
      issuesOf(body),
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

/**
 * GET /api/house; null when there is no usable layout (404). `readOnly`: the server keeps the
 * last good layout but won't accept writes (`X-Housebook-Read-Only`, data contract §2.3).
 */
export async function fetchHouse(): Promise<{
  house: House;
  etag: string | null;
  readOnly: boolean;
} | null> {
  try {
    const res = await request('/api/house', { cache: 'no-store' });
    return {
      house: (await res.json()) as House,
      etag: unquoteEtag(res.headers.get('ETag')),
      readOnly: res.headers.get('X-Housebook-Read-Only')?.toLowerCase() === 'true',
    };
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

/**
 * PATCH /api/items/{id} with `If-Match` (data contract §8.2): `frontmatter` is a JSON Merge
 * Patch (`null` deletes a key), `body` replaces the body. A 412 means the note changed since
 * `etag` was read.
 */
export async function patchItem(id: string, patch: ItemPatch, etag: string): Promise<Item> {
  const res = await request(`/api/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${unquoteEtag(etag)}"` },
    body: JSON.stringify(patch),
  });
  return (await res.json()) as Item;
}

/**
 * DELETE /api/items/{id} with `If-Match`: the note and its attachment folder go to
 * `.housebook/trash/` (data contract §8.2). Remove the placement first (D8).
 */
export async function deleteItemRequest(id: string, etag: string): Promise<void> {
  await request(`/api/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: { 'If-Match': `"${unquoteEtag(etag)}"` },
  });
}

/** POST /api/items: create a note (D8: the client places it with PUT /api/house afterwards). */
export const postItem = (body: ItemCreate) => postJson<Item>('/api/items', body);

/**
 * PUT /api/house with `If-Match` (data contract §8.1): the layout as written and its new ETag.
 * A 412 is an ApiError with status 412 (the caller replays its pending edits, DESIGN 15.2).
 */
export async function putHouse(
  house: House,
  ifMatch: string | null,
): Promise<{ house: House; etag: string | null }> {
  const res = await request('/api/house', {
    method: 'PUT',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      // No ETag known means "there was no house.json" (first run): create it.
      ...(ifMatch ? { 'If-Match': `"${unquoteEtag(ifMatch)}"` } : { 'If-None-Match': '*' }),
    },
    body: JSON.stringify(house),
  });
  return { house: (await res.json()) as House, etag: unquoteEtag(res.headers.get('ETag')) };
}

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
