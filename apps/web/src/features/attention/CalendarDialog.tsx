/**
 * "Add to your calendar" (D40): make, replace or turn off the person's calendar link. The
 * server keeps only a fingerprint of the code, so the link is shown once, right after it is made.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createCalendarLink,
  deleteCalendarLink,
  getCalendarLink,
} from '../../api/client';
import type { CalendarLink } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { formatDate } from '../../domain/dates';

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'exists'; createdAt: string }
  | { kind: 'new'; url: string }
  | { kind: 'error'; text: string };

const why = (err: unknown) =>
  err instanceof ApiError
    ? (err.detail ?? err.message)
    : 'the server couldn’t be reached. Try again in a moment';

const fromServer = (l: CalendarLink): State =>
  l.url
    ? { kind: 'new', url: l.url }
    : l.exists && l.createdAt
      ? { kind: 'exists', createdAt: l.createdAt }
      : { kind: 'none' };

function NewLink({ url }: { url: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('Copied.');
    } catch {
      // No clipboard (plain http, old browser): select it for Ctrl+C.
      input.current?.select();
      setCopied('Selected: press Ctrl+C (⌘C) to copy.');
    }
  };
  return (
    <>
      <p>
        <b>Your calendar link.</b> It is shown only now: copy it into your calendar app.
      </p>
      <div className="cal-link">
        <input
          ref={input}
          readOnly
          value={url}
          aria-label="Calendar link"
          onFocus={(e) => e.target.select()}
        />
        <button type="button" className="btn primary" onClick={() => void copy()}>
          Copy
        </button>
      </div>
      <p className="msg" role="status">
        {copied ?? ''}
      </p>
      <ul className="cal-howto">
        <li>
          <b>Google Calendar</b> (on a computer): Other calendars → + → From URL. Google fetches it
          from the internet, so Housebook must be reachable from outside your home.
        </li>
        <li>
          <b>Apple Calendar</b>: File → New Calendar Subscription. iPhone: Settings → Calendar →
          Accounts → Add Account → Other → Add Subscribed Calendar.
        </li>
        <li>
          <b>Outlook</b>: Add calendar → Subscribe from web. <b>Thunderbird</b>: New Calendar → On
          the Network.
        </li>
      </ul>
      <p className="muted">
        Anyone with this link can see your items’ names, rooms and dates, but not notes or files. If
        it gets out, make a new link here: the old one stops working.
      </p>
    </>
  );
}

export function CalendarDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getCalendarLink()
      .then((l) => live && setState(fromServer(l)))
      .catch(
        (e: unknown) => live && setState({ kind: 'error', text: `Couldn’t check: ${why(e)}.` }),
      );
    return () => {
      live = false;
    };
  }, []);

  const run = async (action: () => Promise<State>, failed: string) => {
    setBusy(true);
    try {
      setState(await action());
    } catch (e) {
      setState({ kind: 'error', text: `${failed}: ${why(e)}.` });
    } finally {
      setBusy(false);
    }
  };
  const make = () =>
    void run(async () => fromServer(await createCalendarLink()), 'Couldn’t make the link');
  const turnOff = () =>
    void run(async () => {
      await deleteCalendarLink();
      return { kind: 'none' };
    }, 'Couldn’t turn the link off');

  return (
    <Dialog title="Add to your calendar" onClose={onClose} className="calendar-dialog">
      <p className="muted">
        Every item’s next check and warranty end, as all-day events in your own calendar app. It
        stays up to date by itself; changes in the calendar don’t change Housebook.
      </p>
      {state.kind === 'loading' && <p role="status">Checking…</p>}
      {state.kind === 'error' && (
        <p className="msg err" role="alert">
          {state.text}
        </p>
      )}
      {state.kind === 'none' && (
        <div className="cal-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={make}>
            Make my calendar link
          </button>
        </div>
      )}
      {state.kind === 'exists' && (
        <>
          <p>
            You made a calendar link on {formatDate(state.createdAt.slice(0, 10))}. It can’t be
            shown again: Housebook keeps only a fingerprint of it.
          </p>
          <div className="cal-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={make}>
              Make a new link
            </button>
            <button type="button" className="btn" disabled={busy} onClick={turnOff}>
              Turn the link off
            </button>
          </div>
          <p className="muted">Either way, calendars using the old link stop updating.</p>
        </>
      )}
      {state.kind === 'new' && (
        <>
          <NewLink url={state.url} />
          <div className="cal-actions">
            <button type="button" className="btn" disabled={busy} onClick={turnOff}>
              Turn the link off
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
