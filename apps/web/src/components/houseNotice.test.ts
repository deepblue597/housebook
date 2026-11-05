import { describe, expect, it } from 'vitest';
import type { Problem } from '../api/types';
import { readOnlyNotice } from './houseNotice';

const p = (kind: Problem['kind'], message: string): Problem => ({
  kind,
  severity: 'error',
  message,
  path: 'house.json',
});

describe('read-only notice', () => {
  it('names a newer schema only when the API says so', () => {
    const n = readOnlyNotice([p('house_newer_version', 'newer')], 2);
    expect(n.reason).toBe('newer_version');
    expect(n.text).toContain('newer Housebook version (schema 2)');
  });
  it('explains a bad or missing schemaVersion', () => {
    const n = readOnlyNotice(
      [
        p(
          'house_invalid',
          'house.json is invalid: schemaVersion must be an integer >= 1 (got missing)',
        ),
      ],
      null,
    );
    expect(n.reason).toBe('bad_version');
    expect(n.text).not.toMatch(/newer/);
  });
  it('explains an invalid file', () => {
    const n = readOnlyNotice([p('house_invalid', 'house.json is invalid: grid: bad')], 1);
    expect(n).toMatchObject({ reason: 'invalid', detail: 'house.json is invalid: grid: bad' });
    expect(n.text).not.toMatch(/newer/);
  });
  it('never guesses while the report is loading', () => {
    expect(readOnlyNotice(null, 1).text).toBe('The house layout is read-only.');
  });
});
