import type { paths } from './schema.gen';
import type { Snapshot } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

type JsonOf<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': infer T } } } };
}
  ? T
  : never;

async function request(path: keyof paths, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  if (!res.ok && res.status !== 304) {
    throw new ApiError(
      res.status,
      `${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}`,
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
