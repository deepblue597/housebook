/**
 * "Add to maintenance log" (POST /api/items/{id}/log, D11). Editors only. An append needs no
 * If-Match and merges with whatever is on disk, so it never conflicts.
 */
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client';
import type { Item } from '../../api/types';
import { useData } from '../../store/data';

export function LogEntryForm({ item }: { item: Item }) {
  const appendLog = useData((s) => s.appendLog);
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);

  if (item.stale)
    return (
      <p className="muted log-form">Log entries can be added again once the note can be read.</p>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entry = text.trim();
    if (!entry) {
      setMsg({ text: 'Write what was done first.', err: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await appendLog(item.id, entry, date || undefined);
      setText('');
      setDate('');
      setMsg({ text: 'Added to the maintenance log.', err: false });
    } catch (err) {
      const why =
        err instanceof ApiError
          ? err.status === 403
            ? 'you can only view this house'
            : err.status === 409 && err.reason === 'unparseable'
              ? 'the note can’t be read; fix it in an editor first'
              : (err.detail ?? err.message)
          : 'the server couldn’t be reached';
      setMsg({ text: `Couldn’t add the entry: ${why}.`, err: true });
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
    </form>
  );
}
