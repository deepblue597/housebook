import { type Ref, type RefObject, useEffect, useRef, useState } from 'react';
import type { Item } from '../../api/types';
import { selectionFromPath } from '../../app/router';
import { typeLabel } from '../../catalog/catalog';
import { TypeIcon } from '../../catalog/TypeIcon';
import { currentStatus, statusChips } from '../../components/status';
import { formatDate } from '../../domain/dates';
import { isWebUrl, safeExternalHref } from '../../domain/urls';
import { type Model, floorOf, roomOf } from '../../store/model';
import { useUi } from '../../store/ui';
import { useData } from '../../store/data';
import { ItemLayoutActions } from '../editor';
import { Attachments } from './Attachments';
import { LogEntryForm } from './LogEntryForm';
import { manualSearchUrl, resolveWikilink } from './links';
import { Notes } from './Notes';

function ExternalLink({
  href,
  label,
  primary,
}: {
  href: string;
  label: string;
  primary?: boolean;
}) {
  const web = isWebUrl(href);
  return (
    <a
      className={primary ? 'primary' : undefined}
      href={href}
      target={web ? '_blank' : undefined}
      rel="noopener noreferrer"
    >
      {label}
    </a>
  );
}

type CopyState = 'idle' | 'copied' | 'selected';

/**
 * Copy to the clipboard. Where the Clipboard API is missing or refused (plain http on the LAN,
 * permissions), select the text instead so Ctrl+C / long-press copy works.
 */
function CopyButton({
  text,
  label,
  fallbackTarget,
}: {
  text: string;
  label: string;
  fallbackTarget: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);

  const selectFallback = () => {
    const el = fallbackTarget.current;
    const sel = window.getSelection();
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setState('selected');
  };

  const copy = () => {
    try {
      navigator.clipboard.writeText(text).then(() => setState('copied'), selectFallback);
    } catch {
      selectFallback();
    }
  };

  return (
    <>
      <button type="button" className="btn" onClick={copy}>
        {label}
      </button>
      <span className="copy-status" role="status">
        {state === 'copied'
          ? 'Copied'
          : state === 'selected'
            ? 'Selected: press Ctrl+C to copy'
            : ''}
      </span>
    </>
  );
}

interface Props {
  item: Item;
  model: Model;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
}

export function ItemDetails({ item, model, headingRef, onClose }: Props) {
  const select = useUi((s) => s.select);
  const editor = useData((s) => s.me?.role === 'editor');
  const f = item.fields;
  const status = currentStatus(item, model.snapshot);
  const chips = statusChips(status);
  const room = roomOf(model, item);
  const floor = floorOf(model, item);
  const pathRef = useRef<HTMLElement>(null);
  const manual = safeExternalHref(f.manual);
  const findManual = manualSearchUrl(f.brand, f.model);
  const support = safeExternalHref(f.support);

  const specs: [string, string | null | undefined][] = [
    ['Type', typeLabel(item.type)],
    ['Brand', f.brand],
    ['Model', f.model],
    ['Serial', f.serial],
    ['Purchased', f.purchased && formatDate(f.purchased)],
    ['Warranty until', f.warranty_until && formatDate(f.warranty_until)],
    [
      'Next check',
      status.check &&
        `${formatDate(status.check.date)}${status.check.derived ? ` (every ${f.check_every})` : ''}`,
    ],
    ['Check every', !status.check?.derived ? f.check_every : null],
  ];

  return (
    <article className="details" aria-labelledby="details-title">
      <header className="p-head">
        <div className="p-icon">
          <TypeIcon type={item.type} />
        </div>
        <div className="grow">
          <p className="eyebrow">
            {room?.name ?? 'No room'} · {floor?.floor.name ?? 'Unplaced'}
          </p>
          <h2 id="details-title" ref={headingRef} tabIndex={-1}>
            {item.name}
          </h2>
          {(f.brand || f.model) && (
            <p className="sub">{[f.brand, f.model].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      {item.stale && (
        <p className="notice" role="note">
          This note currently can’t be read ({item.parseError ?? 'parse error'}); showing the last
          good version.
        </p>
      )}

      {(chips.length > 0 || item.critical) && (
        <ul className="chips" aria-label="Status">
          {chips.map((c) => (
            <li key={c.text} className={`chip ${c.tone}`}>
              <span aria-hidden="true">{c.glyph}</span> {c.text}
            </li>
          ))}
          {item.critical && (
            <li className="chip muted">
              <span aria-hidden="true">✚</span> Emergency item
            </li>
          )}
        </ul>
      )}

      <ItemLayoutActions itemId={item.id} />

      <dl className="specs">
        {specs
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      {(manual || support || item.obsidianUrl) && (
        <div className="links">
          {manual && <ExternalLink href={manual} label="Manual" primary />}
          {support && <ExternalLink href={support} label="Support" />}
          {item.obsidianUrl && <ExternalLink href={item.obsidianUrl} label="Open in Obsidian" />}
        </div>
      )}

      <section aria-label="Notes">
        <Notes
          body={item.body}
          resolve={(link) => resolveWikilink(model, item, link)}
          onNavigate={(href) => select(selectionFromPath(href))}
        />
      </section>

      {editor && <LogEntryForm key={item.id} item={item} />}

      <Attachments attachments={item.attachments} />

      <footer className="note-foot">
        <p className="path">
          <span className="eyebrow">Note</span> <code ref={pathRef}>{item.path}</code>
        </p>
        <div className="links">
          <CopyButton text={item.path} fallbackTarget={pathRef} label="Copy path" />
          {findManual && <ExternalLink href={findManual} label="Find manual online" />}
        </div>
      </footer>
    </article>
  );
}
