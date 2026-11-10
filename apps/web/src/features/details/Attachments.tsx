import { type DragEvent, Suspense, lazy, useRef, useState } from 'react';
import { ApiError, MAX_UPLOAD_BYTES } from '../../api/client';
import type { Attachment, Item } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { useData } from '../../store/data';
import { formatSize, isImageName, isPdfName } from './links';

/** What the file picker offers; the server decides by content (D33). */
const ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';

function uploadError(name: string, e: unknown): string {
  if (!(e instanceof ApiError)) return `${name}: the server couldn’t be reached.`;
  if (e.status === 413) return `${name}: too large (25 MB at most).`;
  if (e.status === 415) return `${name}: only PDF, JPEG, PNG, WebP or HEIC files can be attached.`;
  if (e.status === 409 && e.reason === 'unparseable')
    return `${name}: the note can’t be read right now; fix it in a text editor first.`;
  return `${name}: ${e.detail ?? e.message}`;
}

/** Editors: add files (picker or drop), remove one (to the trash). */
function useAttachmentWrites(itemId: string) {
  const add = useData((s) => s.addAttachment);
  const remove = useData((s) => s.removeAttachment);
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const upload = async (files: File[]) => {
    if (files.length === 0 || progress) return;
    setErrors([]);
    setDone(null);
    const failed: string[] = [];
    let ok = 0;
    for (const [i, file] of files.entries()) {
      setProgress(
        files.length > 1
          ? `Uploading ${i + 1} of ${files.length}: ${file.name}…`
          : `Uploading ${file.name}…`,
      );
      if (file.size > MAX_UPLOAD_BYTES) {
        failed.push(`${file.name}: too large (25 MB at most).`);
        continue;
      }
      try {
        await add(itemId, file, file.name);
        ok += 1;
      } catch (e) {
        failed.push(uploadError(file.name, e));
      }
    }
    setProgress(null);
    setErrors(failed);
    if (ok > 0) setDone(ok === 1 ? 'File added.' : `${ok} files added.`);
  };

  const removeFile = async (name: string) => {
    setErrors([]);
    setDone(null);
    try {
      await remove(itemId, name);
      setDone(`${name} moved to the trash.`);
    } catch (e) {
      setErrors([
        e instanceof ApiError && e.reason === 'not_in_folder'
          ? `${name} is stored outside this item’s folder and may be shared, so it wasn’t deleted. Remove its link in the note instead.`
          : e instanceof ApiError
            ? `Couldn’t remove ${name}: ${e.detail ?? e.message}`
            : `Couldn’t remove ${name}: the server couldn’t be reached.`,
      ]);
    }
  };

  return { upload, removeFile, progress, errors, done };
}

const PdfViewer = lazy(() => import('./PdfViewer'));

type Open = { kind: 'pdf' | 'image'; att: Attachment } | null;

/** Message for a file listed in the snapshot that the server can no longer serve. */
function Unavailable({ att }: { att: Attachment }) {
  return (
    <p role="alert" className="unavailable">
      This file is not available. It may have been moved or deleted since the page loaded.{' '}
      <a href={att.url} download={att.name}>
        Try downloading it
      </a>
      .
    </p>
  );
}

function ImagePreview({ att }: { att: Attachment }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <Unavailable att={att} />
  ) : (
    <img className="preview" src={att.url} alt={att.name} onError={() => setFailed(true)} />
  );
}

function Thumbnail({ att }: { att: Attachment }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="file-ico" aria-hidden="true">
      IMG
    </span>
  ) : (
    <img src={att.url} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}

export function Attachments({ item, editor }: { item: Item; editor: boolean }) {
  const attachments = item.attachments;
  const [open, setOpen] = useState<Open>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const writes = useAttachmentWrites(item.id);
  const canWrite = editor && !item.stale;
  if (attachments.length === 0 && !canWrite) return null;

  const onDrop = (e: DragEvent) => {
    if (!canWrite || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    void writes.upload([...e.dataTransfer.files]);
  };

  return (
    <section
      className={`attachments${dragging ? ' dropping' : ''}`}
      aria-labelledby="att-h"
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="att-head">
        <h3 id="att-h" className="eyebrow">
          Attachments
        </h3>
        {canWrite && (
          <>
            <button
              type="button"
              className="btn"
              disabled={!!writes.progress}
              onClick={() => input.current?.click()}
            >
              Add files
            </button>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              aria-label="Files to attach"
              onChange={(e) => {
                void writes.upload([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      {canWrite && (
        <div className="att-status" role="status">
          {writes.progress ??
            writes.done ??
            (attachments.length === 0
              ? 'Manuals, receipts, photos: PDF, JPEG, PNG, WebP or HEIC, up to 25 MB. Drop files here or use Add files.'
              : '')}
        </div>
      )}
      {writes.errors.length > 0 && (
        <div role="alert">
          <ul className="att-errors">
            {writes.errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <ul>
        {attachments.map((a) => {
          const image = isImageName(a.name);
          const pdf = isPdfName(a.name);
          return (
            <li key={a.url}>
              {image ? (
                <button
                  type="button"
                  className="thumb"
                  onClick={() => setOpen({ kind: 'image', att: a })}
                >
                  <Thumbnail att={a} />
                  <span className="sr-only">{`Preview ${a.name}`}</span>
                </button>
              ) : (
                <span className="file-ico" aria-hidden="true">
                  {pdf ? 'PDF' : 'FILE'}
                </span>
              )}
              <span className="grow">
                {a.name}
                <small>{formatSize(a.size)}</small>
              </span>
              {pdf && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOpen({ kind: 'pdf', att: a })}
                >
                  View<span className="sr-only">{` ${a.name}`}</span>
                </button>
              )}
              <a className="btn" href={a.url} download={a.name}>
                Download<span className="sr-only">{` ${a.name}`}</span>
              </a>
              {canWrite &&
                (confirming === a.name ? (
                  <span className="att-confirm">
                    <button
                      type="button"
                      className="btn danger"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => {
                        setConfirming(null);
                        void writes.removeFile(a.name);
                      }}
                    >
                      Remove
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${a.name}`}
                    title="Move to the trash"
                    onClick={() => setConfirming(a.name)}
                  >
                    ✕
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {open && (
        <Dialog title={open.att.name} onClose={() => setOpen(null)} className={open.kind}>
          {open.kind === 'pdf' ? (
            <Suspense fallback={<p>Loading the PDF viewer…</p>}>
              <PdfViewer url={open.att.url} name={open.att.name} />
            </Suspense>
          ) : (
            <ImagePreview att={open.att} />
          )}
        </Dialog>
      )}
    </section>
  );
}
