/**
 * Live sync (data contract §9, DESIGN 15.7): server-sent events from GET /api/events, with
 * polling as the fallback when they don't get through.
 *
 * - `live`: an EventSource is open and has had its `resync`. Events go to the data store.
 * - On an error the stream is closed and `/api/me` decides: 401 (or a redirect to the login
 *   page) reloads the page so the proxy can sign the user in again. Reloads are limited to one
 *   a minute; a declined reload shows `signed_out` and sync keeps retrying like after any other
 *   error, so it recovers by itself once the login works again. Otherwise it reconnects after
 *   `reconnectMs`.
 * - A stream that opens but never sends `resync` (a buffering proxy), or that sends nothing at
 *   all for `eventTimeoutMs` (the server sends `ping` after 20 s of silence; a half-open
 *   connection on a sleeping phone sends nothing) counts as an error too.
 * - After `maxErrors` errors in a row: polling, GET /api/snapshot with If-None-Match every
 *   `pollMs`, plus a try at SSE every `sseRetryMs`; the first `resync` goes back to `live`.
 *   The status is `polling` only while polls succeed, `offline` while they fail.
 * - Focus and visibility revalidate the snapshot in every mode (cheap 304s). While the tab is
 *   hidden nothing is polled, and after `hiddenCloseMs` the stream is closed; coming back
 *   reconnects and resyncs.
 * - The indicator shows settled states only (`settleStatus`): no flicker during an outage.
 */
import { create } from 'zustand';
import { type AuthCheck, checkAuth } from '../api/client';
import type {
  HouseChangedEvent,
  ItemChangedEvent,
  ItemDeletedEvent,
  ProblemsChangedEvent,
  ResyncEvent,
} from '../api/types';
import { type LoadResult, useData } from './data';

export type SyncStatus = 'connecting' | 'live' | 'polling' | 'offline' | 'signed_out';

export interface Timings {
  reconnectMs: number;
  maxErrors: number;
  pollMs: number;
  sseRetryMs: number;
  resyncTimeoutMs: number;
  hiddenCloseMs: number;
  /** No event at all (not even `ping`) for this long: the stream is dead. */
  eventTimeoutMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  reconnectMs: 5_000, // the server's `retry:`
  maxErrors: 3,
  pollMs: 30_000,
  sseRetryMs: 60_000,
  resyncTimeoutMs: 15_000,
  hiddenCloseMs: 60_000,
  eventTimeoutMs: 45_000, // data contract §9: the server pings after 20 s of silence
};

/** The part of EventSource the client uses (tests pass a fake). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void;
  close(): void;
}

export interface SyncHandlers {
  resync: (e: ResyncEvent) => unknown;
  'house.changed': (e: HouseChangedEvent) => unknown;
  'item.changed': (e: ItemChangedEvent) => unknown;
  'item.deleted': (e: ItemDeletedEvent) => unknown;
  'problems.changed': (e: ProblemsChangedEvent) => unknown;
}

export interface SyncDeps {
  openEvents: (url: string) => EventSourceLike;
  checkAuth: () => Promise<AuthCheck>;
  /** Revalidate the snapshot (If-None-Match). */
  poll: () => Promise<LoadResult>;
  /** Reload for a new login; false when declined (it reloaded less than a minute ago). */
  reload: () => boolean;
  isHidden: () => boolean;
  handlers: SyncHandlers;
  onStatus: (s: SyncStatus) => void;
  timings?: Partial<Timings>;
}

const EVENTS = ['house.changed', 'item.changed', 'item.deleted', 'problems.changed'] as const;
type TimerName = 'reconnect' | 'resync' | 'poll' | 'sseRetry' | 'hidden' | 'watchdog';

export class SyncClient {
  status: SyncStatus = 'connecting';
  private readonly t: Timings;
  private readonly deps: SyncDeps;
  private es: EventSourceLike | null = null;
  private failures = 0;
  private mode: 'sse' | 'polling' = 'sse';
  /** Stream closed because the tab was hidden. */
  private paused = false;
  /** Stopped, or the page is reloading. */
  private stopped = false;
  private pollDue = false;
  private timers: Partial<Record<TimerName, ReturnType<typeof setTimeout>>> = {};

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.closeStream();
    for (const k of Object.keys(this.timers) as TimerName[]) this.clear(k);
  }

  /** Window focus or a visibility change. */
  onVisibility(): void {
    if (this.stopped) return;
    if (this.deps.isHidden()) {
      if (this.mode === 'sse' && this.es && this.timers.hidden === undefined)
        this.timers.hidden = setTimeout(() => {
          delete this.timers.hidden;
          if (!this.deps.isHidden() || this.mode !== 'sse') return;
          this.paused = true;
          this.clear('reconnect');
          this.clear('watchdog');
          this.clear('resync');
          this.closeStream();
          this.setStatus('connecting');
        }, this.t.hiddenCloseMs);
      return;
    }
    this.clear('hidden');
    if (this.paused) {
      this.paused = false;
      this.failures = 0;
      this.connect();
    }
    this.pollDue = false;
    void this.poll();
  }

  // ---- stream ------------------------------------------------------------------------------

  private connect(): void {
    this.closeStream();
    this.clear('reconnect');
    const es = this.deps.openEvents('/api/events');
    this.es = es;
    const mine = () => this.es === es && !this.stopped;
    /** Anything from the server proves the stream is alive. */
    const alive = () => {
      this.clear('watchdog');
      this.timers.watchdog = setTimeout(() => {
        delete this.timers.watchdog;
        if (mine()) this.onError();
      }, this.t.eventTimeoutMs);
    };
    es.addEventListener('open', () => {
      if (!mine()) return;
      alive();
      this.clear('resync');
      this.timers.resync = setTimeout(() => {
        delete this.timers.resync;
        if (mine()) this.onError();
      }, this.t.resyncTimeoutMs);
    });
    es.addEventListener('error', () => {
      if (mine()) this.onError();
    });
    es.addEventListener('ping', () => {
      if (mine()) alive();
    });
    es.addEventListener('resync', (e) => {
      if (!mine()) return;
      const data = parse<ResyncEvent>(e);
      if (!data) return;
      alive();
      this.clear('resync');
      this.failures = 0;
      if (this.mode === 'polling') {
        this.mode = 'sse';
        this.clear('poll');
        this.clear('sseRetry');
      }
      this.setStatus('live');
      this.deps.handlers.resync(data);
    });
    for (const name of EVENTS)
      es.addEventListener(name, (e) => {
        if (!mine()) return;
        alive();
        const data = parse(e);
        if (data) (this.deps.handlers[name] as (d: unknown) => unknown)(data);
      });
  }

  private onError(): void {
    this.closeStream();
    this.clear('resync');
    this.clear('watchdog');
    this.failures += 1;
    void this.deps.checkAuth().then((auth) => {
      if (this.stopped || this.paused) return;
      if (auth === 'unauthorized' && this.signedOut()) return;
      if (this.mode === 'polling') {
        // A retry from polling mode failed: the polls decide the status; try again later.
        this.scheduleSseRetry();
        return;
      }
      if (this.failures >= this.t.maxErrors) {
        this.enterPolling();
        return;
      }
      if (auth === 'unreachable') this.setStatus('offline');
      this.timers.reconnect = setTimeout(() => {
        delete this.timers.reconnect;
        this.connect();
      }, this.t.reconnectMs);
    });
  }

  /**
   * The login expired. Reload (the proxy signs the user in again); if the reload is declined
   * (one a minute), say so and keep going: the caller retries as after any error.
   * Returns true when the page is reloading.
   */
  private signedOut(): boolean {
    if (this.deps.reload()) {
      this.stop();
      return true;
    }
    this.setStatus('signed_out');
    return false;
  }

  // ---- polling -----------------------------------------------------------------------------

  private enterPolling(): void {
    this.mode = 'polling';
    void this.poll();
    this.schedulePoll();
    this.scheduleSseRetry();
  }

  private schedulePoll(): void {
    this.clear('poll');
    this.timers.poll = setTimeout(() => {
      delete this.timers.poll;
      if (this.mode !== 'polling' || this.stopped) return;
      // Hidden: skip, and poll as soon as the tab is visible again (onVisibility).
      if (this.deps.isHidden()) this.pollDue = true;
      else void this.poll();
      this.schedulePoll();
    }, this.t.pollMs);
  }

  private scheduleSseRetry(): void {
    this.clear('sseRetry');
    this.timers.sseRetry = setTimeout(() => {
      delete this.timers.sseRetry;
      if (this.mode !== 'polling' || this.stopped) return;
      if (this.deps.isHidden()) this.scheduleSseRetry();
      else this.connect();
    }, this.t.sseRetryMs);
  }

  private async poll(): Promise<void> {
    const result = await this.deps.poll();
    if (this.stopped) return;
    let auth: AuthCheck = 'ok';
    if (result === 'unauthorized') auth = 'unauthorized';
    else if (result === 'failed') auth = await this.deps.checkAuth();
    if (this.stopped) return;
    if (auth === 'unauthorized') {
      this.signedOut();
      return;
    }
    if (this.mode !== 'polling') return;
    this.setStatus(result === 'ok' ? 'polling' : 'offline');
  }

  // ---- helpers -----------------------------------------------------------------------------

  private closeStream(): void {
    this.es?.close();
    this.es = null;
  }

  private clear(k: TimerName): void {
    const id = this.timers[k];
    if (id !== undefined) clearTimeout(id);
    delete this.timers[k];
  }

  private setStatus(s: SyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.deps.onStatus(s);
  }

  /** For tests. */
  get pollPending(): boolean {
    return this.pollDue;
  }
}

function parse<T = unknown>(e: MessageEvent<string>): T | null {
  try {
    return JSON.parse(e.data) as T;
  } catch {
    return null;
  }
}

/**
 * Pass on only settled statuses: `live` at once (good news is final), anything else only if it
 * still holds `ms` later. The indicator (an ARIA live region) then announces outcomes, not every
 * step of a reconnect attempt.
 */
export function settleStatus(
  apply: (s: SyncStatus) => void,
  ms = 2_000,
): ((s: SyncStatus) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fn = (s: SyncStatus) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (s === 'live') apply(s);
    else
      timer = setTimeout(() => {
        timer = undefined;
        apply(s);
      }, ms);
  };
  return Object.assign(fn, {
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}

// ---- the app's instance ---------------------------------------------------------------------

export const useSync = create<{ status: SyncStatus }>()(() => ({ status: 'connecting' }));

const RELOAD_KEY = 'housebook.authReloadAt';
/** Reload so the proxy can re-authenticate, at most once a minute (no reload loop). */
export function reloadForAuth(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (now - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // no storage: reload anyway
  }
  window.location.reload();
  return true;
}

declare global {
  interface Window {
    /** e2e only (non-production builds): shorter sync timings. */
    __housebookSyncTimings?: Partial<Timings> & { settleMs?: number };
  }
}

/** Start live sync for the app; returns a stop function. */
export function startSync(): () => void {
  const data = useData.getState();
  const timings = import.meta.env.MODE !== 'production' ? window.__housebookSyncTimings : undefined;
  const show = settleStatus((status) => useSync.setState({ status }), timings?.settleMs);
  const client = new SyncClient({
    openEvents: (url) => new EventSource(url, { withCredentials: true }),
    checkAuth,
    poll: () => useData.getState().load(),
    reload: () => reloadForAuth(),
    isHidden: () => document.visibilityState === 'hidden',
    handlers: {
      resync: data.resync,
      'house.changed': data.houseChanged,
      'item.changed': data.itemChanged,
      'item.deleted': data.itemDeleted,
      'problems.changed': data.problemsChanged,
    },
    onStatus: show,
    ...(timings ? { timings } : {}),
  });
  const onVisibility = () => client.onVisibility();
  window.addEventListener('focus', onVisibility);
  document.addEventListener('visibilitychange', onVisibility);
  client.start();
  return () => {
    window.removeEventListener('focus', onVisibility);
    document.removeEventListener('visibilitychange', onVisibility);
    show.cancel();
    client.stop();
  };
}
