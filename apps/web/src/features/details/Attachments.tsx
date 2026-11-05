import { Suspense, lazy, useState } from 'react';
import type { Attachment } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { formatSize, isImageName, isPdfName } from './links';

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

export function Attachments({ attachments }: { attachments: Attachment[] }) {
  const [open, setOpen] = useState<Open>(null);
  if (attachments.length === 0) return null;

  return (
    <section className="attachments" aria-labelledby="att-h">
      <h3 id="att-h" className="eyebrow">
        Attachments
      </h3>
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
