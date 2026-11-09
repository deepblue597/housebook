/**
 * The note editor's rules, without React (D31). The form starts from the note's raw frontmatter,
 * sends only the keys the user changed (a JSON Merge Patch, data contract §8.2), and merges a
 * version saved elsewhere meanwhile field by field: only keys changed on both sides conflict.
 */
import type { Item, ItemPatch } from '../../api/types';

export type FieldKey =
  | 'name'
  | 'brand'
  | 'model'
  | 'serial'
  | 'purchased'
  | 'warranty_until'
  | 'next_check'
  | 'check_every'
  | 'manual'
  | 'support'
  | 'critical';

export type FieldKind = 'text' | 'date' | 'interval' | 'url' | 'critical';

export interface FieldSpec {
  key: FieldKey;
  label: string;
  kind: FieldKind;
}

export const FIELDS: readonly FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'brand', label: 'Brand', kind: 'text' },
  { key: 'model', label: 'Model', kind: 'text' },
  { key: 'serial', label: 'Serial number', kind: 'text' },
  { key: 'purchased', label: 'Purchased', kind: 'date' },
  { key: 'warranty_until', label: 'Warranty until', kind: 'date' },
  { key: 'next_check', label: 'Next check', kind: 'date' },
  { key: 'check_every', label: 'Check every', kind: 'interval' },
  { key: 'manual', label: 'Manual link', kind: 'url' },
  { key: 'support', label: 'Support link', kind: 'url' },
  { key: 'critical', label: 'Emergency item', kind: 'critical' },
];

/** Everything the form edits; `critical` is '' (type default), 'true' or 'false'. */
export type NoteValues = Record<FieldKey, string> & { body: string };
export type ValueKey = FieldKey | 'body';

export interface NoteDraft {
  /** ETag of the version `base` was read from: the `If-Match` of the save. */
  etag: string;
  /** The values as read; a key whose value still equals its base value is not sent. */
  base: NoteValues;
  values: NoteValues;
  /** Keys changed here and, differently, in a version saved elsewhere meanwhile. */
  conflicts: ValueKey[];
  /** Raw values the form can't show (a date that isn't one), by key. */
  unreadable: Partial<Record<FieldKey, string>>;
}

const TRUE = new Set(['true', 'yes', 'on', '1']);
const FALSE = new Set(['false', 'no', 'off', '0']);

/** The form's values for an item: raw frontmatter strings, so nothing is rewritten unasked. */
export function valuesOf(item: Item): {
  values: NoteValues;
  unreadable: Partial<Record<FieldKey, string>>;
} {
  const values = { body: item.body } as NoteValues;
  const unreadable: Partial<Record<FieldKey, string>> = {};
  for (const { key, kind } of FIELDS) {
    const raw = item.frontmatter[key];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (kind === 'critical') {
      const v = text.toLowerCase();
      values[key] = TRUE.has(v) ? 'true' : FALSE.has(v) ? 'false' : '';
    } else if (kind === 'date') {
      // The server accepts a datetime prefix; a date input shows YYYY-MM-DD only.
      const typed = item.fields[key];
      values[key] = typeof typed === 'string' ? typed : '';
      if (!values[key] && text) unreadable[key] = text;
    } else {
      values[key] = typeof raw === 'string' ? raw : '';
    }
  }
  return { values, unreadable };
}

export function startDraft(item: Item): NoteDraft {
  const { values, unreadable } = valuesOf(item);
  return { etag: item.etag, base: values, values: { ...values }, conflicts: [], unreadable };
}

const KEYS: readonly ValueKey[] = [...FIELDS.map((f) => f.key), 'body'];

export const changedKeys = (d: Pick<NoteDraft, 'base' | 'values'>): ValueKey[] =>
  KEYS.filter((k) => d.values[k] !== d.base[k]);

/** The PATCH body for what changed; null when nothing did. */
export function buildPatch(d: Pick<NoteDraft, 'base' | 'values'>): ItemPatch | null {
  const frontmatter: Record<string, string | boolean | null> = {};
  let body: string | undefined;
  for (const k of changedKeys(d)) {
    const v = d.values[k];
    if (k === 'body') body = v;
    else if (k === 'critical') frontmatter[k] = v === '' ? null : v === 'true';
    else frontmatter[k] = v.trim() === '' ? null : v.trim();
  }
  const patch: ItemPatch = {};
  if (Object.keys(frontmatter).length > 0) patch.frontmatter = frontmatter;
  if (body !== undefined) patch.body = body;
  return Object.keys(patch).length > 0 ? patch : null;
}

const INTERVAL = /^0*[1-9]\d*[dwmy]$/i;
const URL_SCHEMES = /^(https?:\/\/|mailto:|tel:|obsidian:\/\/)/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Problems with the changed values, by key (unchanged keys are never judged). */
export function validate(d: Pick<NoteDraft, 'base' | 'values'>): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const k of changedKeys(d)) {
    if (k === 'body') continue;
    const v = d.values[k].trim();
    if (!v) continue;
    const kind = FIELDS.find((f) => f.key === k)!.kind;
    if (kind === 'interval' && !INTERVAL.test(v))
      errors[k] = 'A number and d, w, m or y, like 6m or 1y.';
    else if (kind === 'url' && !URL_SCHEMES.test(v))
      errors[k] = 'Start with https://, http://, mailto:, tel: or obsidian://.';
    else if (kind === 'text' && CONTROL.test(v)) errors[k] = 'Use a single line.';
  }
  return errors;
}

/**
 * Move a draft onto a newer version of the note (after a 412). Keys the user didn't change take
 * the new value; changed keys keep the user's value. A key is a conflict when the other side
 * changed it too, to something else.
 */
export function rebase(d: NoteDraft, latest: Item): NoteDraft {
  const next = startDraft(latest);
  const values = { ...next.values };
  const conflicts: ValueKey[] = [];
  for (const k of changedKeys(d)) {
    values[k] = d.values[k];
    const theirs = next.base[k];
    if (theirs !== d.base[k] && theirs !== d.values[k]) conflicts.push(k);
  }
  return { ...next, values, conflicts };
}

/** Field errors of a 422 (`loc: ["body", "frontmatter", key]`); the rest as one message. */
export function serverErrors(
  issues: readonly { loc: readonly (string | number)[]; msg: string }[],
): {
  fields: Partial<Record<FieldKey, string>>;
  other: string[];
} {
  const fields: Partial<Record<FieldKey, string>> = {};
  const other: string[] = [];
  for (const { loc, msg } of issues) {
    const key = loc[0] === 'body' && loc[1] === 'frontmatter' ? loc[2] : undefined;
    const spec = FIELDS.find((f) => f.key === key);
    if (spec) fields[spec.key] = msg;
    else other.push(msg);
  }
  return { fields, other };
}
