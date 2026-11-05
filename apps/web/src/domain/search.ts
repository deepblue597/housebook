/**
 * Search matching (DESIGN 15.9, data contract §5). Mirrors apps/api/.../domain/search.py and is
 * driven by the same golden cases (contract/fixtures/search_cases.json).
 *
 * - The query is folded and split on whitespace; every token must match some field (AND).
 * - Substring matching on folded text; model, serial and error codes also match in compact form.
 * - Each token scores the best tier it hits; an item's score is the sum (lower is better).
 * - Ties: name starts with the query, then folded name, then id.
 */
import { compact, fold } from './text';

export const Tier = {
  name: 1,
  errorCode: 2,
  modelBrand: 3, // model, brand, serial
  typeRoom: 4, // catalogue type label, room name
  body: 5,
} as const;

export interface SearchFields {
  id: string;
  name?: string;
  errorCodes?: readonly string[];
  model?: string;
  brand?: string;
  serial?: string;
  typeLabel?: string;
  room?: string;
  body?: string;
}

interface IndexedField {
  tier: number;
  folded: string;
  compacted: string;
}

export interface SearchDoc {
  id: string;
  foldedName: string;
  fields: readonly IndexedField[];
}

export function toSearchDoc(f: SearchFields): SearchDoc {
  const field = (tier: number, value = '', withCompact = false): IndexedField => ({
    tier,
    folded: fold(value),
    compacted: withCompact ? compact(value) : '',
  });
  const fields = [
    field(Tier.name, f.name),
    ...(f.errorCodes ?? []).map((c) => field(Tier.errorCode, c, true)),
    field(Tier.modelBrand, f.model, true),
    field(Tier.modelBrand, f.brand),
    field(Tier.modelBrand, f.serial, true),
    field(Tier.typeRoom, f.typeLabel),
    field(Tier.typeRoom, f.room),
    field(Tier.body, f.body),
  ].filter((x) => x.folded !== '');
  return { id: f.id, foldedName: fold(f.name ?? ''), fields };
}

export const tokens = (query: string): string[] => fold(query).split(/\s+/u).filter(Boolean);

/** Sum of the best tier per token, or null if some token doesn't match. */
export function score(doc: SearchDoc, query: string): number | null {
  let total = 0;
  for (const tok of tokens(query)) {
    const tokCompact = compact(tok);
    // Fields are ordered by tier, so the first hit is the best one.
    const hit = doc.fields.find(
      (f) =>
        f.folded.includes(tok) ||
        (f.compacted !== '' && tokCompact !== '' && f.compacted.includes(tokCompact)),
    );
    if (!hit) return null;
    total += hit.tier;
  }
  return total;
}

const byKey = (a: readonly (number | string)[], b: readonly (number | string)[]): number => {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

/** Ids of matching docs, best first. An empty or blank query matches nothing. */
export function search(docs: readonly SearchDoc[], query: string): string[] {
  if (tokens(query).length === 0) return [];
  const q = fold(query).trim();
  const hits: [number, number, string, string][] = [];
  for (const doc of docs) {
    const s = score(doc, query);
    if (s !== null) hits.push([s, doc.foldedName.startsWith(q) ? 0 : 1, doc.foldedName, doc.id]);
  }
  // Code-point comparison, like Python's tuple sort (not localeCompare).
  return hits.sort(byKey).map((h) => h[3]);
}
