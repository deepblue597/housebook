/**
 * Text normalisation shared by search and attachment matching. Mirrors
 * apps/api/src/housebook/domain/text.py; golden cases in contract/fixtures/search_cases.json.
 */

const COMBINING_MARK = /\p{Mn}/gu;
const COMPACT_SEPARATORS = /[\s\-_./]+/gu;

export const nfc = (value: string): string => value.normalize('NFC');

/**
 * Case- and accent-insensitive form: NFD, drop combining marks, lower-case, final sigma
 * `ς` -> `σ`, NFC. `ψυγείο`, `ΨΥΓΕΙΟ` and `ψυγειο` all fold to `ψυγειο`.
 *
 * `toLowerCase()` matches Python's `str.lower()` (the backend deliberately avoids `casefold()`).
 */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARK, '')
    .toLowerCase()
    .replaceAll('ς', 'σ')
    .normalize('NFC');
}

/** Folded form without spaces and separators, so `FD041200123` matches `FD 0412 00123`. */
export const compact = (value: string): string => fold(value).replace(COMPACT_SEPARATORS, '');
