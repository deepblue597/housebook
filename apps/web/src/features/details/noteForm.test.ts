import { describe, expect, it } from 'vitest';
import { makeItem } from '../../test/fixtures';
import {
  type NoteDraft,
  buildPatch,
  changedKeys,
  rebase,
  serverErrors,
  startDraft,
  validate,
  valuesOf,
} from './noteForm';

const note = makeItem({
  id: 'it_x',
  name: 'Dishwasher',
  etag: 'v1',
  frontmatter: {
    housebook_id: 'it_x',
    name: 'Dishwasher',
    brand: 'Bosch',
    serial: '0123',
    purchased: '2024-05-10T10:00',
    next_check: 'next spring',
    critical: 'yes',
    tags: ['housebook'],
  },
  fields: { name: 'Dishwasher', brand: 'Bosch', serial: '0123', purchased: '2024-05-10' },
  body: '## Notes\nSalt every 2 months.',
});

const edit = (d: NoteDraft, values: Partial<NoteDraft['values']>): NoteDraft => ({
  ...d,
  values: { ...d.values, ...values },
});

describe('valuesOf', () => {
  it('starts from the raw frontmatter, so untouched values are never rewritten', () => {
    const { values, unreadable } = valuesOf(note);
    expect(values.serial).toBe('0123'); // not a number
    expect(values.purchased).toBe('2024-05-10'); // the date input's format
    expect(values.model).toBe('');
    expect(values.critical).toBe('true'); // "yes"
    expect(values.body).toBe(note.body);
    expect(unreadable).toEqual({ next_check: 'next spring' });
  });

  it('an unset or unknown critical value means the type default', () => {
    expect(valuesOf(makeItem({ id: 'a', name: 'a' })).values.critical).toBe('');
    expect(
      valuesOf(makeItem({ id: 'a', name: 'a', frontmatter: { critical: 'maybe' } })).values
        .critical,
    ).toBe('');
  });
});

describe('buildPatch', () => {
  it('is null when nothing changed', () => {
    expect(buildPatch(startDraft(note))).toBeNull();
  });

  it('sends only changed keys: trimmed text, null to remove, booleans for critical, the body', () => {
    const d = edit(startDraft(note), {
      brand: '  Siemens ',
      serial: '',
      critical: 'false',
      body: 'new body',
    });
    expect(changedKeys(d)).toEqual(['brand', 'serial', 'critical', 'body']);
    expect(buildPatch(d)).toEqual({
      frontmatter: { brand: 'Siemens', serial: null, critical: false },
      body: 'new body',
    });
    expect(buildPatch(edit(startDraft(note), { critical: '' }))).toEqual({
      frontmatter: { critical: null },
    });
  });

  it('a body-only edit sends no frontmatter', () => {
    expect(buildPatch(edit(startDraft(note), { body: 'x' }))).toEqual({ body: 'x' });
  });
});

describe('validate', () => {
  it('judges changed values only', () => {
    const bad = makeItem({ id: 'b', name: 'b', frontmatter: { manual: 'www.x.com' } });
    expect(validate(startDraft(bad))).toEqual({}); // already there: left alone
    const d = edit(startDraft(note), {
      check_every: '6 months',
      manual: 'www.bosch.com',
      support: 'javascript:alert(1)',
      model: 'a\u0007b',
    });
    expect(Object.keys(validate(d)).sort()).toEqual(['check_every', 'manual', 'model', 'support']);
  });

  it('accepts intervals and link schemes the server accepts', () => {
    const d = edit(startDraft(note), {
      check_every: '1Y',
      manual: 'https://x.example',
      support: 'tel:+30210',
    });
    expect(validate(d)).toEqual({});
    expect(validate(edit(startDraft(note), { check_every: '0d' }))).toHaveProperty('check_every');
  });
});

describe('rebase (a version saved elsewhere meanwhile)', () => {
  const theirs = (fm: Record<string, string>, body = note.body) =>
    makeItem({
      ...note,
      etag: 'v2',
      frontmatter: { ...note.frontmatter, ...fm },
      fields: { ...note.fields, ...fm },
      body,
    });

  it('different fields merge: theirs come in, mine stay, no conflict', () => {
    const mine = edit(startDraft(note), { brand: 'Siemens' });
    const r = rebase(mine, theirs({ model: 'SX1' }));
    expect(r.etag).toBe('v2');
    expect(r.conflicts).toEqual([]);
    expect(r.values.model).toBe('SX1');
    expect(buildPatch(r)).toEqual({ frontmatter: { brand: 'Siemens' } });
  });

  it('the same field changed differently on both sides is a conflict; mine is kept', () => {
    const mine = edit(startDraft(note), { brand: 'Siemens', body: 'mine' });
    const r = rebase(mine, theirs({ brand: 'Miele' }, 'theirs'));
    expect(r.conflicts).toEqual(['brand', 'body']);
    expect(r.base.brand).toBe('Miele');
    expect(r.values.brand).toBe('Siemens');
    expect(buildPatch(r)).toEqual({ frontmatter: { brand: 'Siemens' }, body: 'mine' });
  });

  it('both sides made the same change: nothing left to send', () => {
    const mine = edit(startDraft(note), { brand: 'Miele' });
    const r = rebase(mine, theirs({ brand: 'Miele' }));
    expect(r.conflicts).toEqual([]);
    expect(buildPatch(r)).toBeNull();
  });
});

it('serverErrors puts frontmatter issues next to their fields', () => {
  expect(
    serverErrors([
      { loc: ['body', 'frontmatter', 'next_check'], msg: 'not a date' },
      { loc: ['body', 'body'], msg: 'too long' },
    ]),
  ).toEqual({ fields: { next_check: 'not a date' }, other: ['too long'] });
});
