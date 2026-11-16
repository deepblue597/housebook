/**
 * Receipts linked from Paperless-ngx (D52, data contract §3.7 and §8.4). The note keeps the
 * documents' Paperless addresses; titles, dates, thumbnails and previews come through the backend,
 * which holds the token. Without the server (offline) or Paperless, the links show as they are.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { ApiError, fetchReceipts, searchPaperless } from '../../api/client';
import type { Item, PaperlessDoc, Receipt } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { formatDate } from '../../domain/dates';
import { safeExternalHref } from '../../domain/urls';
import { useData } from '../../store/data';
import { RECEIPTS } from '../../strings/receipts';

const PdfViewer = lazy(() => import('./PdfViewer'));

const plain = (url: string): Receipt => ({ url, documentId: null, state: 'link' });

function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

function saveError(e: unknown): string {
  if (!(e instanceof ApiError)) return RECEIPTS.failed(RECEIPTS.offline);
  if (e.status === 412) return RECEIPTS.changed;
  return RECEIPTS.failed(e.detail ?? e.message);
}

function Thumb({ src, title }: { src: string | null | undefined; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span className="file-ico" aria-hidden="true">
        DOC
      </span>
    );
  return (
    <img src={src} alt={RECEIPTS.thumbAlt(title)} loading="lazy" onError={() => setFailed(true)} />
  );
}

export function Receipts({ item, editor }: { item: Item; editor: boolean }) {
  const links = item.fields.receipts ?? [];
  const paperlessUrl = useData((s) => s.model?.snapshot.paperlessUrl ?? null);
  const update = useData((s) => s.updateItem);
  const key = `${item.id}:${item.etag}`;
  const [loaded, setLoaded] = useState<{ key: string; receipts: Receipt[] } | null>(null);
  const [viewing, setViewing] = useState<Receipt | null>(null);
  const [searching, setSearching] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ key: string; text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (links.length === 0) return;
    const ctl = new AbortController();
    fetchReceipts(item.id, ctl.signal).then(
      (receipts) => setLoaded({ key, receipts }),
      () => undefined, // offline or the server is down: the plain links stay
    );
    return () => ctl.abort();
    // `links` is part of the note, so `key` (its etag) covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const canLink = editor && !item.stale && paperlessUrl !== null;
  const canUnlink = editor && !item.stale;
  if (links.length === 0 && !canLink) return null;
  const shown = loaded?.key === key ? loaded.receipts : links.map(plain);

  const save = async (next: string[], done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await update(
        item.id,
        { frontmatter: { receipts: next.length > 0 ? next : null } },
        item.etag,
      );
      setMsg({ key: item.id, text: done, error: false });
    } catch (e) {
      setMsg({ key: item.id, text: saveError(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const unlink = (url: string) => {
    const i = links.indexOf(url);
    void save([...links.slice(0, i), ...links.slice(i + 1)], RECEIPTS.unlinked);
  };

  return (
    <section className="attachments receipts" aria-labelledby="rcpt-h">
      <div className="att-head">
        <h3 id="rcpt-h" className="eyebrow">
          {RECEIPTS.heading}
        </h3>
        {canLink && (
          <button type="button" className="btn" disabled={busy} onClick={() => setSearching(true)}>
            {RECEIPTS.link}
          </button>
        )}
      </div>
      {editor && (
        <div className={`att-status${msg?.error ? ' err' : ''}`} role="status">
          {msg?.key === item.id ? msg.text : links.length === 0 ? RECEIPTS.linkHint : ''}
        </div>
      )}
      <ul>
        {shown.map((r, i) => {
          const href = safeExternalHref(r.url);
          const title = r.title ?? linkLabel(r.url);
          return (
            <li key={`${i}:${r.url}`}>
              {r.state === 'found' ? (
                // The same as View, for the mouse; kept out of the tab order and the reading order.
                <button
                  type="button"
                  className="thumb"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={() => setViewing(r)}
                >
                  <Thumb src={r.thumbUrl} title={title} />
                </button>
              ) : (
                <span className="file-ico" aria-hidden="true">
                  {r.documentId === null ? 'LINK' : 'DOC'}
                </span>
              )}
              <span className="grow">
                {title}
                {r.state === 'found' && r.created && <small>{formatDate(r.created)}</small>}
                {r.state === 'missing' && <small className="warn">{RECEIPTS.missing}</small>}
                {r.state === 'unreachable' && <small>{RECEIPTS.unreachable}</small>}
              </span>
              {r.state === 'found' && (
                <button
                  type="button"
                  className="btn"
                  aria-label={`${RECEIPTS.view} ${title}`}
                  onClick={() => setViewing(r)}
                >
                  {RECEIPTS.view}
                </button>
              )}
              {href && r.state !== 'missing' && (
                <a
                  className="btn"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${r.documentId === null ? RECEIPTS.openLink : RECEIPTS.open} ${title}`}
                >
                  {r.documentId === null ? RECEIPTS.openLink : RECEIPTS.open}
                </a>
              )}
              {canUnlink &&
                (confirming === r.url ? (
                  <span className="att-confirm">
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy}
                      aria-label={`${RECEIPTS.unlink} ${title}`}
                      onClick={() => {
                        setConfirming(null);
                        unlink(r.url);
                      }}
                    >
                      {RECEIPTS.unlink}
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirming(null)}>
                      {RECEIPTS.keep}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`${RECEIPTS.unlink} ${title}`}
                    title={RECEIPTS.unlinkTitle}
                    onClick={() => setConfirming(r.url)}
                  >
                    ✕
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {viewing?.previewUrl && (
        <Dialog
          title={viewing.title ?? RECEIPTS.heading}
          onClose={() => setViewing(null)}
          className="pdf"
        >
          <Suspense fallback={<p>Loading the PDF viewer…</p>}>
            <PdfViewer url={viewing.previewUrl} name={viewing.title ?? 'receipt'} />
          </Suspense>
        </Dialog>
      )}
      {searching && (
        <LinkReceiptDialog
          linked={new Set(links)}
          onClose={() => setSearching(false)}
          onPick={(doc) => {
            setSearching(false);
            void save([...links, doc.url], RECEIPTS.linked);
          }}
        />
      )}
    </section>
  );
}

type Results = { q: string; docs: PaperlessDoc[] } | { q: string; error: string };

function LinkReceiptDialog({
  linked,
  onPick,
  onClose,
}: {
  linked: ReadonlySet<string>;
  onPick: (doc: PaperlessDoc) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(
      () => {
        searchPaperless(q, ctl.signal).then(
          (docs) => setResults({ q, docs }),
          (e: unknown) => {
            if (ctl.signal.aborted) return;
            const detail = e instanceof ApiError ? (e.detail ?? e.message) : RECEIPTS.offline;
            setResults({ q, error: RECEIPTS.searchFailed(detail) });
          },
        );
      },
      q ? 300 : 0,
    );
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q]);

  const current = results?.q === q ? results : null;
  return (
    <Dialog title={RECEIPTS.searchTitle} onClose={onClose} className="receipt-search">
      <label className="field">
        <span>{RECEIPTS.searchLabel}</span>
        <input
          type="search"
          value={q}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
        <small>{RECEIPTS.searchHint}</small>
      </label>
      <p role="status" className="att-status">
        {!current
          ? RECEIPTS.searching
          : 'docs' in current && current.docs.length === 0
            ? RECEIPTS.noResults
            : ''}
      </p>
      {current && 'error' in current && <p role="alert">{current.error}</p>}
      {current && 'docs' in current && current.docs.length > 0 && (
        <ul className="attachments receipt-results">
          {current.docs.map((d) => {
            const done = linked.has(d.url);
            return (
              <li key={d.documentId}>
                <span className="thumb">
                  <Thumb src={d.thumbUrl} title={d.title} />
                </span>
                <span className="grow">
                  {d.title}
                  {d.created && <small>{formatDate(d.created)}</small>}
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={done}
                  aria-label={
                    done ? `${d.title}: ${RECEIPTS.alreadyLinked}` : `${RECEIPTS.pick} ${d.title}`
                  }
                  onClick={() => onPick(d)}
                >
                  {done ? RECEIPTS.alreadyLinked : RECEIPTS.pick}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
