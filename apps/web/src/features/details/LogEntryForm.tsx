/**
 * "Add to maintenance log" (POST /api/items/{id}/log, D11). Editors only. An append needs no
 * If-Match and merges with whatever is on disk, so it never conflicts.
 *
 * Afterwards, an item with a check interval and an explicit next check is offered the entry
 * date plus the interval as its next check (D39), so `next_check` doesn't go stale after the
 * first service. Setting it is a PATCH against the version the log entry returned.
 */
import { type FormEvent, useState } from 'react';
import { ApiError, fetchItem } from '../../api/client';
import type { Item } from '../../api/types';
import { formatDate, todayIn } from '../../domain/dates';
import { intervalText, suggestNextCheck } from '../../domain/status';
import { useData } from '../../store/data';

interface Offer {
  /** The suggested next check (ISO). */
  date: string;
  /** The next check it replaces, and the note version it was read from. */
  from: string;
  etag: string;
  every: string;
}

const why = (err: unknown): string =>
  err instanceof ApiError
    ? err.status === 403
      ? 'you can only view this house'
      : err.status === 409 && err.reason === 'unparseable'
        ? 'the note can’t be read; fix it in an editor first'
        : (err.detail ?? err.message)
    : 'the server couldn’t be reached';

export function LogEntryForm({ item }: { item: Item }) {
  const appendLog = useData((s) => s.appendLog);
  const updateItem = useData((s) => s.updateItem);
  const snapshot = useData((s) => s.model?.snapshot);
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);

  if (item.stale)
    return (
      <p className="muted log-form">Log entries can be added again once the note can be read.</p>
    );

  const today = () => {
    try {
      return snapshot ? todayIn(snapshot.timezone) : null;
    } catch {
      return snapshot?.today ?? null;
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entry = text.trim();
    if (!entry) {
      setMsg({ text: 'Write what was done first.', err: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    setOffer(null);
    try {
      const written = await appendLog(item.id, entry, date || undefined);
      const on = date || today();
      const next = on ? suggestNextCheck(written.fields, on) : null;
      setText('');
      setDate('');
      if (next && written.fields.next_check && written.fields.check_every) {
        setOffer({
          date: next,
          from: written.fields.next_check,
          etag: written.etag,
          every: written.fields.check_every,
        });
        setMsg({
          text: `Added to the maintenance log. Set the next check to ${formatDate(next)}?`,
          err: false,
        });
      } else {
        // Without an explicit next_check, the next check already follows the log: say where.
        const check = written.status.check;
        setMsg({
          text:
            check?.derived && check.state !== 'overdue'
              ? `Added to the maintenance log. Next check: ${formatDate(check.date)}.`
              : 'Added to the maintenance log.',
          err: false,
        });
      }
    } catch (err) {
      setMsg({ text: `Couldn’t add the entry: ${why(err)}.`, err: true });
    } finally {
      setBusy(false);
    }
  };

  const setNextCheck = async (o: Offer) => {
    setBusy(true);
    const patch = { frontmatter: { next_check: o.date } };
    try {
      try {
        await updateItem(item.id, patch, o.etag);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 412)) throw err;
        // Changed meanwhile (another tab, Obsidian). Retry only if nobody touched next_check.
        const fresh = await fetchItem(item.id);
        if (!fresh || fresh.fields.next_check !== o.from) {
          setOffer(null);
          setMsg({
            text: 'The note changed meanwhile, so the next check was left as it is now.',
            err: true,
          });
          return;
        }
        await updateItem(item.id, patch, fresh.etag);
      }
      setOffer(null);
      setMsg({ text: `Next check set to ${formatDate(o.date)}.`, err: false });
    } catch (err) {
      setMsg({ text: `Couldn’t set the next check: ${why(err)}.`, err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="log-form" aria-label="Add to maintenance log" onSubmit={(e) => void submit(e)}>
      <label className="text">
        Maintenance log entry
        <input
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Cleaned the filter"
          disabled={busy}
        />
      </label>
      <label>
        Date (default today)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
      </label>
      <button type="submit" className="btn primary" disabled={busy}>
        Add
      </button>
      <p className={`msg${msg?.err ? ' err' : ''}`} role="status">
        {msg?.text ?? ''}
      </p>
      {offer && (
        <div className="next-offer">
          <p className="muted">
            It is set to {formatDate(offer.from)} now. Checks are every {intervalText(offer.every)},
            counted from this entry.
          </p>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void setNextCheck(offer)}
          >
            Set next check to {formatDate(offer.date)}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setOffer(null);
              setMsg({ text: 'Added to the maintenance log.', err: false });
            }}
          >
            Keep {formatDate(offer.from)}
          </button>
        </div>
      )}
    </form>
  );
}
