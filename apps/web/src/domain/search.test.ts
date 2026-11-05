// Golden cases shared with the backend (pytest runs the same file).
import fixtures from '@contract/fixtures/search_cases.json';
import { describe, expect, it } from 'vitest';
import { errorCodes } from './notes';
import { search, toSearchDoc } from './search';
import { compact, fold } from './text';

const docs = fixtures.items.map((i) =>
  toSearchDoc({
    id: i.id,
    name: i.name,
    brand: i.brand,
    model: i.model,
    serial: i.serial,
    typeLabel: i.type_label,
    room: i.room,
    body: i.body,
    errorCodes: errorCodes(i.body),
  }),
);

describe('search (contract/fixtures/search_cases.json)', () => {
  it.each(fixtures.fold_cases)('fold(%j) = %j', (input, expected) => {
    expect(fold(input)).toBe(expected);
  });

  it.each(fixtures.error_code_cases.map((c, i) => [i, c] as const))('error codes #%i', (_i, c) => {
    expect(errorCodes(c.body)).toEqual(c.codes);
  });

  it.each(fixtures.cases.map((c) => [c.q, c] as const))('query %j', (_q, c) => {
    expect(search(docs, c.q)).toEqual(c.expect);
  });

  it('compacts separators for model and serial matching', () => {
    expect(compact('FD 0412-00_123./x')).toBe('fd041200123x');
  });
});
