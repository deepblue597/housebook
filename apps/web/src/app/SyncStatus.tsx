/** Small connection indicator in the top bar: live / polling / offline (DESIGN 15.7). */
import { type SyncStatus as Status, useSync } from '../store/sync';

const SHORT: Record<Status, string> = {
  connecting: 'Connecting',
  live: 'Live',
  polling: 'Polling',
  offline: 'Offline',
  signed_out: 'Signed out',
};

const LONG: Record<Status, string> = {
  connecting: 'Sync: connecting for live updates',
  live: 'Sync: live, changes appear as they happen',
  polling: 'Sync: live updates aren’t getting through, checking for changes every 30 seconds',
  offline: 'Sync: can’t reach the server, showing the last loaded data',
  signed_out: 'Sync: your login has expired; reload the page to sign in again',
};

export function SyncStatus() {
  const status = useSync((s) => s.status);
  return (
    <span className={`sync ${status}`} role="status" data-sync={status} title={LONG[status]}>
      <span className="dot" aria-hidden="true" />
      <span className="label" aria-hidden="true">
        {SHORT[status]}
      </span>
      <span className="sr-only">{LONG[status]}</span>
    </span>
  );
}
