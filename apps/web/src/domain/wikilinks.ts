/**
 * Obsidian `[[wikilinks]]` and `![[embeds]]` in note bodies (DESIGN 15.16). The app renders them
 * as plain text, or as links when they resolve to an item or an attachment.
 */
import { fold, nfc } from './text';

export interface Wikilink {
  /** Link target without alias or heading: `Dishwasher/manual.pdf`. */
  target: string;
  /** `#heading` or `#^block` part, if any. */
  subpath: string;
  /** Text after `|`, if any. */
  alias: string | null;
  embed: boolean;
}

export type Segment =
  { kind: 'text'; text: string } | { kind: 'link'; link: Wikilink; raw: string };

const WIKILINK = /(!?)\[\[([^\]\n|]+?)(?:\|([^\]\n]*))?\]\]/gu;

export function splitWikilinks(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(WIKILINK)) {
    const start = m.index;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    const [raw, bang, inner, alias] = m;
    const hash = inner!.indexOf('#');
    out.push({
      kind: 'link',
      raw,
      link: {
        target: (hash >= 0 ? inner!.slice(0, hash) : inner!).trim(),
        subpath: hash >= 0 ? inner!.slice(hash) : '',
        alias: alias?.trim() || null,
        embed: bang === '!',
      },
    });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * What a wikilink shows: its alias, else `Note › Heading` for heading links (Obsidian's own
 * rendering), else the target. Block references (`#^id`) show the note only.
 */
export function wikilinkLabel(l: Wikilink): string {
  if (l.alias) return l.alias;
  const parts = l.subpath
    .split('#')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('^'));
  const label = [l.target, ...parts].filter(Boolean).join(' › ');
  return label || l.subpath.replace(/^#\^?/u, '');
}

/** Last path component without a `.md` extension: `House/Kitchen/Dishwasher.md` -> `Dishwasher`. */
export const noteBasename = (path: string): string =>
  (path.split('/').at(-1) ?? path).replace(/\.md$/iu, '');

/** Key for matching link targets to file names: NFC, case- and accent-insensitive. */
export const linkKey = (name: string): string => fold(nfc(name.trim()));
