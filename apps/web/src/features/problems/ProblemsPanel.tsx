/**
 * The integrity report (GET /api/problems) grouped by kind (DESIGN 15.2). Lazy chunk, loaded
 * when the badge is first opened. Every fix is an explicit action; only adoption is wired so
 * far (the other fixes arrive with the editor), the rest is information.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, getJson } from '../../api/client';
import type { Problem } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { useData } from '../../store/data';
import { useUi } from '../../store/ui';
import { SEVERITY_TEXT, groupProblems, problemText } from './problemText';

type Load =
  { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; list: Problem[] };

/** Adopt a `not_adopted` note. The result is announced by the panel: the entry itself
 * disappears from the refetched list once the note has its id. */
function AdoptButton({ path, onResult }: { path: string; onResult: (msg: Notice) => void }) {
  const adopt = useData((s) => s.adopt);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const item = await adopt(path);
      onResult({ text: `Adopted ${path} as ${item.id}.`, err: false });
    } catch (e) {
      const text = e instanceof ApiError ? (e.detail ?? e.message) : String(e);
      onResult({ text: `Couldn’t adopt ${path}: ${text}`, err: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
      {busy ? 'Adopting…' : 'Adopt'}
    </button>
  );
}

interface Notice {
  text: string;
  err: boolean;
}

export default function ProblemsPanel({ onClose }: { onClose: () => void }) {
  const rev = useData((s) => s.problemsRev);
  const model = useData((s) => s.model);
  const editor = useData((s) => s.me?.role === 'editor');
  const select = useUi((s) => s.select);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // The adopted entry leaves the list with its button: keep focus in the dialog, on the result.
  const announce = (n: Notice) => {
    setNotice(n);
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

  // Refetch whenever the server says the report changed (problems.changed / resync).
  useEffect(() => {
    const ctrl = new AbortController();
    getJson('/api/problems', ctrl.signal).then(
      (r) => setLoad({ state: 'ready', list: r.problems }),
      (e: unknown) => {
        if (!ctrl.signal.aborted)
          setLoad({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ctrl.abort();
  }, [rev]);

  const show = (id: string) => {
    select({ kind: 'item', id });
    onClose();
  };

  return (
    <Dialog title="Data problems" onClose={onClose} className="problems-dialog">
      <p
        ref={noticeRef}
        tabIndex={-1}
        role="status"
        className={notice?.err ? 'notice err' : notice ? 'notice' : 'sr-only'}
      >
        {notice?.text ?? ''}
      </p>
      {load.state === 'loading' && <p className="muted">Loading…</p>}
      {load.state === 'error' && (
        <p className="muted" role="alert">
          Couldn’t load the problems: {load.error}
        </p>
      )}
      {load.state === 'ready' && load.list.length === 0 && (
        <p className="muted">No problems. Everything in the data folder is in order.</p>
      )}
      {load.state === 'ready' &&
        groupProblems(load.list).map((g) => {
          const text = problemText(g.kind);
          const headingId = `pg-${g.kind}`;
          return (
            <section key={g.kind} aria-labelledby={headingId} data-kind={g.kind}>
              <h3 id={headingId}>
                {text.title} ({g.problems.length})
              </h3>
              {text.help && <p className="help">{text.help}</p>}
              <ul>
                {g.problems.map((p, i) => {
                  const known =
                    !!p.itemId && (model?.items.has(p.itemId) || model?.placements.has(p.itemId));
                  return (
                    <li key={`${p.path ?? ''}:${p.itemId ?? ''}:${i}`}>
                      <span className={`sev ${p.severity}`}>
                        {SEVERITY_TEXT[p.severity] ?? p.severity}
                      </span>
                      {p.message}
                      {p.path && (
                        <div>
                          <code>{p.path}</code>
                        </div>
                      )}
                      {(known || (editor && g.kind === 'not_adopted' && p.path)) && (
                        <div className="acts">
                          {known && (
                            <button type="button" className="link" onClick={() => show(p.itemId!)}>
                              Show {model?.items.get(p.itemId!)?.name ?? p.itemId}
                            </button>
                          )}
                          {editor && g.kind === 'not_adopted' && p.path && (
                            <AdoptButton path={p.path} onResult={announce} />
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
    </Dialog>
  );
}
