import type { Item } from '../../api/types';
import { itemPath } from '../../app/router';
import { type Wikilink, linkKey, noteBasename } from '../../domain/wikilinks';
import type { Model } from '../../store/model';
import type { ResolvedLink } from './MarkdownBody';

const IMAGE = /\.(png|jpe?g|gif|webp)$/iu;
export const isImageName = (name: string): boolean => IMAGE.test(name);
export const isPdfName = (name: string): boolean => /\.pdf$/iu.test(name);

/**
 * Resolve a wikilink from `item`'s note: first its own attachments (by file name), then other
 * items (by note file name or display name). Anything else stays plain text.
 */
export function resolveWikilink(model: Model, item: Item, link: Wikilink): ResolvedLink | null {
  if (!link.target) return null;
  const file = linkKey(link.target.split('/').at(-1) ?? link.target);
  const att = item.attachments.find((a) => linkKey(a.name) === file);
  if (att) return { href: att.url, image: isImageName(att.name) };

  if (/\.[a-z0-9]{1,5}$/iu.test(link.target) && !/\.md$/iu.test(link.target)) return null;
  const note = linkKey(noteBasename(link.target));
  for (const other of model.items.values()) {
    if (linkKey(noteBasename(other.path)) === note || linkKey(other.name) === note) {
      return { href: itemPath(other.id) };
    }
  }
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A web search for the manual (secondary to attaching the PDF, DESIGN 15.16). */
export function manualSearchUrl(brand?: string | null, model?: string | null): string | null {
  const terms = [brand, model].filter(Boolean);
  if (terms.length === 0) return null;
  const q = encodeURIComponent([...terms, 'manual pdf'].join(' '));
  return `https://www.google.com/search?q=${q}`;
}
