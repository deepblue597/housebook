import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCheck } from '../api/client';
import type { LoadResult } from './data';
import {
  type EventSourceLike,
  SyncClient,
  type SyncDeps,
  type SyncStatus,
  reloadForAuth,
  settleStatus,
} from './sync';

class FakeEs implements EventSourceLike {
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const e = { data: data === undefined ? '' : JSON.stringify(data) } as MessageEvent<string>;
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

const RESYNC = { houseEtag: 'h', houseReadOnly: false, itemsVersion: 'v', problemCount: 0 };
const T = {
  reconnectMs: 100,
  maxErrors: 3,
  pollMs: 1_000,
  sseRetryMs: 5_000,
  resyncTimeoutMs: 500,
  hiddenCloseMs: 2_000,
  eventTimeoutMs: 3_000,
};

function setup(over: Partial<SyncDeps> = {}) {
  const streams: FakeEs[] = [];
  const statuses: SyncStatus[] = [];
  let hidden = false;
  const auth = { value: 'ok' as AuthCheck };
  const pollResult = { value: 'ok' as LoadResult };
  const poll = vi.fn(() => Promise.resolve(pollResult.value));
  const reload = vi.fn((): boolean => true);
  const deps = {
    openEvents: vi.fn(() => {
      const es = new FakeEs();
      streams.push(es);
      return es;
    }),
    checkAuth: vi.fn(() => Promise.resolve(auth.value)),
    poll,
    reload,
    isHidden: () => hidden,
    handlers: {
      resync: vi.fn(),
      'house.changed': vi.fn(),
      'item.changed': vi.fn(),
      'item.deleted': vi.fn(),
      'problems.changed': vi.fn(),
    },
    onStatus: (s: SyncStatus) => statuses.push(s),
    timings: T,
    ...over,
  };
  const client = new SyncClient(deps);
  return {
    client,
    deps,
    poll,
    reload,
    streams,
    statuses,
    auth,
    pollResult,
    last: () => streams[streams.length - 1]!,
    setHidden: (h: boolean) => (hidden = h),
  };
}

/** Let promise callbacks (checkAuth, poll) run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('SyncClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('goes live on resync and forwards events to the store', () => {
    const s = setup();
    s.client.start();
    expect(s.deps.openEvents).toHaveBeenCalledWith('/api/events');
    expect(s.client.status).toBe('connecting');
    s.last().emit('open');
    s.last().emit('resync', RESYNC);
    expect(s.client.status).toBe('live');
    expect(s.deps.handlers.resync).toHaveBeenCalledWith(RESYNC);
    const changed = { id: 'it_a', etag: 'e', path: 'p', stale: false, attachmentsEtag: 'a' };
    s.last().emit('item.changed', changed);
    s.last().emit('item.deleted', { id: 'it_b' });
    s.last().emit('house.changed', { etag: 'h2', readOnly: false });
    s.last().emit('problems.changed', { count: 2 });
    expect(s.deps.handlers['item.changed']).toHaveBeenCalledWith(changed);
    expect(s.deps.handlers['item.deleted']).toHaveBeenCalledWith({ id: 'it_b' });
    expect(s.deps.handlers['house.changed']).toHaveBeenCalledWith({ etag: 'h2', readOnly: false });
    expect(s.deps.handlers['problems.changed']).toHaveBeenCalledWith({ count: 2 });
  });

  it('ignores malformed event data', () => {
    const s = setup();
    s.client.start();
    const e = { data: '{nope' } as MessageEvent<string>;
    (s.last() as unknown as { listeners: Map<string, ((e: MessageEvent) => void)[]> }).listeners
      .get('item.changed')!
      .forEach((fn) => fn(e));
    expect(s.deps.handlers['item.changed']).not.toHaveBeenCalled();
  });

  it('on error checks /api/me and reconnects after the delay', async () => {
    const s = setup();
    s.client.start();
    s.last().emit('resync', RESYNC);
    s.last().emit('error');
    expect(s.last().closed).toBe(true);
    await flush();
    expect(s.deps.checkAuth).toHaveBeenCalledTimes(1);
    expect(s.deps.reload).not.toHaveBeenCalled();
    expect(s.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(T.reconnectMs);
    expect(s.streams).toHaveLength(2);
    s.last().emit('resync', RESYNC);
    expect(s.client.status).toBe('live');
  });

  it('reloads the page when /api/me says 401 (expired login behind the proxy)', async () => {
    const s = setup();
    s.auth.value = 'unauthorized';
    s.client.start();
    s.last().emit('error');
    await flush();
    expect(s.deps.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(T.reconnectMs * 2);
    expect(s.streams).toHaveLength(1); // no reconnect loop while reloading
  });

  it('shows offline when the server is unreachable', async () => {
    const s = setup();
    s.auth.value = 'unreachable';
    s.client.start();
    s.last().emit('error');
    await flush();
    expect(s.client.status).toBe('offline');
  });

  it('falls back to polling after repeated errors, polls every pollMs, retries SSE', async () => {
    const s = setup();
    s.client.start();
    for (let i = 0; i < T.maxErrors; i++) {
      s.last().emit('error');
      await flush();
      if (i < T.maxErrors - 1) await vi.advanceTimersByTimeAsync(T.reconnectMs);
    }
    expect(s.client.status).toBe('polling');
    expect(s.streams).toHaveLength(T.maxErrors);
    expect(s.deps.poll).toHaveBeenCalledTimes(1); // at once
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.deps.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.deps.poll).toHaveBeenCalledTimes(3);

    // The periodic SSE try: a failure keeps polling ...
    await vi.advanceTimersByTimeAsync(T.sseRetryMs - 2 * T.pollMs);
    expect(s.streams).toHaveLength(T.maxErrors + 1);
    s.last().emit('error');
    await flush();
    expect(s.client.status).toBe('polling');
    const polls = s.poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.poll.mock.calls.length).toBe(polls + 1);

    // ... a resync goes back to live and stops polling.
    await vi.advanceTimersByTimeAsync(T.sseRetryMs);
    s.last().emit('resync', RESYNC);
    expect(s.client.status).toBe('live');
    const after = s.poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(T.pollMs * 5);
    expect(s.poll.mock.calls.length).toBe(after);
  });

  it('a successful resync resets the error count', async () => {
    const s = setup();
    s.client.start();
    for (let round = 0; round < 3; round++) {
      s.last().emit('error');
      await flush();
      await vi.advanceTimersByTimeAsync(T.reconnectMs);
      s.last().emit('resync', RESYNC);
    }
    expect(s.client.status).toBe('live');
    expect(s.deps.poll).not.toHaveBeenCalled();
  });

  it('a stream that opens but never sends resync (buffering proxy) counts as an error', async () => {
    const s = setup();
    s.client.start();
    s.last().emit('open');
    await vi.advanceTimersByTimeAsync(T.resyncTimeoutMs);
    expect(s.streams[0]!.closed).toBe(true);
    expect(s.deps.checkAuth).toHaveBeenCalledTimes(1);
  });

  it('polling: offline when a poll fails, back to polling when it works; 401 reloads', async () => {
    const s = setup({ timings: { ...T, maxErrors: 1 } });
    s.client.start();
    s.last().emit('error');
    await flush();
    expect(s.client.status).toBe('polling');
    s.pollResult.value = 'failed';
    s.auth.value = 'unreachable';
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.client.status).toBe('offline');
    s.pollResult.value = 'ok';
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.client.status).toBe('polling');
    s.pollResult.value = 'unauthorized';
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.deps.reload).toHaveBeenCalled();
  });

  it('a failed poll whose /api/me says 401 reloads too', async () => {
    const s = setup();
    s.pollResult.value = 'failed';
    s.auth.value = 'unauthorized';
    s.client.start();
    s.client.onVisibility();
    await flush();
    expect(s.deps.reload).toHaveBeenCalled();
  });

  it('focus revalidates the snapshot in live mode too', async () => {
    const s = setup();
    s.client.start();
    s.last().emit('resync', RESYNC);
    s.client.onVisibility();
    await flush();
    expect(s.deps.poll).toHaveBeenCalledTimes(1);
    expect(s.client.status).toBe('live');
  });

  it('hidden tab: no polls, and the stream closes after a while; visible again reconnects', async () => {
    const s = setup({ timings: { ...T, maxErrors: 1 } });
    s.client.start();
    s.last().emit('error');
    await flush();
    expect(s.client.status).toBe('polling');
    const polls = s.poll.mock.calls.length;
    s.setHidden(true);
    s.client.onVisibility();
    await vi.advanceTimersByTimeAsync(T.pollMs * 3);
    expect(s.poll.mock.calls.length).toBe(polls);
    expect(s.client.pollPending).toBe(true);
    s.setHidden(false);
    s.client.onVisibility();
    await flush();
    expect(s.poll.mock.calls.length).toBe(polls + 1);

    const live = setup();
    live.client.start();
    live.last().emit('resync', RESYNC);
    live.setHidden(true);
    live.client.onVisibility();
    await vi.advanceTimersByTimeAsync(T.hiddenCloseMs);
    expect(live.last().closed).toBe(true);
    expect(live.streams).toHaveLength(1);
    live.setHidden(false);
    live.client.onVisibility();
    expect(live.streams).toHaveLength(2);
    live.last().emit('resync', RESYNC);
    expect(live.client.status).toBe('live');
  });

  it('a short hide keeps the stream', async () => {
    const s = setup({ timings: { ...T, eventTimeoutMs: 60_000 } });
    s.client.start();
    s.last().emit('resync', RESYNC);
    s.setHidden(true);
    s.client.onVisibility();
    await vi.advanceTimersByTimeAsync(T.hiddenCloseMs / 2);
    s.setHidden(false);
    s.client.onVisibility();
    await vi.advanceTimersByTimeAsync(T.hiddenCloseMs);
    expect(s.last().closed).toBe(false);
    expect(s.streams).toHaveLength(1);
  });

  it('events from a replaced stream are ignored; stop closes everything', async () => {
    const s = setup();
    s.client.start();
    const first = s.last();
    first.emit('error');
    await flush();
    await vi.advanceTimersByTimeAsync(T.reconnectMs);
    first.emit('item.deleted', { id: 'x' });
    expect(s.deps.handlers['item.deleted']).not.toHaveBeenCalled();
    s.client.stop();
    expect(s.last().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(T.sseRetryMs * 2);
    expect(s.streams).toHaveLength(2);
  });
});

describe('SyncClient (verification fixes)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('M4V-01: a declined reload shows signed_out and keeps retrying until the login works', async () => {
    const s = setup();
    s.reload.mockReturnValue(false);
    s.auth.value = 'unauthorized';
    s.client.start();
    s.last().emit('error');
    await flush();
    expect(s.deps.reload).toHaveBeenCalledTimes(1);
    expect(s.client.status).toBe('signed_out');
    await vi.advanceTimersByTimeAsync(T.reconnectMs);
    expect(s.streams).toHaveLength(2); // still retrying
    s.auth.value = 'ok';
    s.last().emit('resync', RESYNC);
    expect(s.client.status).toBe('live');
  });

  it('M4V-01: in polling mode a declined reload keeps polling and retrying SSE', async () => {
    const s = setup({ timings: { ...T, maxErrors: 1 } });
    s.reload.mockReturnValue(false);
    s.pollResult.value = 'unauthorized';
    s.client.start();
    s.last().emit('error');
    await flush();
    expect(s.client.status).toBe('signed_out');
    s.pollResult.value = 'ok';
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.client.status).toBe('polling');
    await vi.advanceTimersByTimeAsync(T.sseRetryMs);
    s.last().emit('resync', RESYNC);
    expect(s.client.status).toBe('live');
  });

  it('an accepted reload stops everything (no retries while the page reloads)', async () => {
    const s = setup();
    s.auth.value = 'unauthorized';
    s.client.start();
    s.last().emit('error');
    await flush();
    await vi.advanceTimersByTimeAsync(T.sseRetryMs * 2);
    expect(s.streams).toHaveLength(1);
    expect(s.poll).not.toHaveBeenCalled();
  });

  it('watchdog: no event of any kind for eventTimeoutMs reconnects; ping keeps it alive', async () => {
    const s = setup();
    s.client.start();
    s.last().emit('open');
    s.last().emit('resync', RESYNC);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(T.eventTimeoutMs - 100);
      s.last().emit('ping', {});
    }
    expect(s.streams).toHaveLength(1);
    expect(s.deps.checkAuth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(T.eventTimeoutMs);
    expect(s.streams[0]!.closed).toBe(true);
    expect(s.deps.checkAuth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(T.reconnectMs);
    expect(s.streams).toHaveLength(2);
  });

  it('server unreachable: offline throughout, never "polling" while polls fail', async () => {
    const s = setup();
    s.auth.value = 'unreachable';
    s.pollResult.value = 'failed';
    s.client.start();
    for (let i = 0; i < 6; i++) {
      s.last().emit('error');
      await vi.advanceTimersByTimeAsync(T.reconnectMs);
    }
    await vi.advanceTimersByTimeAsync(T.sseRetryMs);
    expect(s.statuses).toEqual(['offline']);
    s.pollResult.value = 'ok';
    await vi.advanceTimersByTimeAsync(T.pollMs);
    expect(s.client.status).toBe('polling');
  });
});

describe('settleStatus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes live at once and other states only once they hold', () => {
    const shown: SyncStatus[] = [];
    const show = settleStatus((s) => shown.push(s), 1_000);
    show('offline');
    vi.advanceTimersByTime(500);
    show('connecting');
    vi.advanceTimersByTime(500);
    show('offline');
    vi.advanceTimersByTime(999);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(['offline']);
    show('polling');
    show('live');
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual(['offline', 'live']);
  });
});

describe('reloadForAuth', () => {
  it('reloads at most once a minute', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    sessionStorage.clear();
    expect(reloadForAuth(1_000_000)).toBe(true);
    expect(reloadForAuth(1_030_000)).toBe(false);
    expect(reloadForAuth(1_061_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
