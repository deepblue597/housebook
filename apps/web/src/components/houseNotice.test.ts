import { describe, expect, it } from 'vitest';
import type { HouseProblemReason, Problem } from '../api/types';
import { readOnlyNotice } from './houseNotice';

const p = (kind: Problem['kind'], message: string, reason?: string): Problem => ({
  kind,
  severity: 'error',
  message,
  path: 'house.json',
  ...(reason ? { detail: { reason: reason as HouseProblemReason } } : {}),
});

describe('read-only notice (switches on detail.reason, data contract §7.1)', () => {
  it('names a newer schema only when the API says so', () => {
    const n = readOnlyNotice([p('house_newer_version', 'newer', 'newer_version')], 2);
    expect(n.reason).toBe('newer_version');
    expect(n.text).toContain('newer Housebook version (schema 2)');
  });
  it('a newer file: the companion house_invalid message is the detail', () => {
    const n = readOnlyNotice(
      [
        p('house_invalid', "house.json can't be displayed by this image", 'newer_version'),
        p('house_newer_version', 'schemaVersion 3 is newer', 'newer_version'),
      ],
      3,
    );
    expect(n).toMatchObject({
      reason: 'newer_version',
      detail: "house.json can't be displayed by this image",
    });
  });
  it('explains a bad or missing schemaVersion', () => {
    const n = readOnlyNotice(
      [p('house_invalid', 'house.json is invalid: schemaVersion missing', 'bad_version')],
      null,
    );
    expect(n.reason).toBe('bad_version');
    expect(n.text).toMatch(/schemaVersion/);
    expect(n.text).not.toMatch(/newer/);
  });
  it('explains an invalid file', () => {
    const n = readOnlyNotice(
      [p('house_invalid', 'house.json is invalid: grid: bad', 'invalid')],
      1,
    );
    expect(n).toMatchObject({ reason: 'invalid', detail: 'house.json is invalid: grid: bad' });
    expect(n.text).not.toMatch(/newer/);
  });
  it('explains a JSON syntax error', () => {
    const n = readOnlyNotice([p('house_invalid', 'Expecting , delimiter', 'not_json')], null);
    expect(n.reason).toBe('not_json');
    expect(n.text).toMatch(/is not valid JSON/);
  });
  it('FE-09: says a file that can’t be read can’t be read, not that it is invalid', () => {
    const n = readOnlyNotice(
      [p('house_invalid', "house.json can't be read: PermissionError", 'unreadable')],
      1,
    );
    expect(n.reason).toBe('unreadable');
    expect(n.text).toMatch(/can’t be read/);
    expect(n.text).not.toMatch(/not valid/);
    expect(n.detail).toContain('PermissionError');
  });
  it('M2-08: a file over 16 MiB says so and doesn’t blame permissions', () => {
    const n = readOnlyNotice([p('house_invalid', 'house.json is too large', 'too_large')], 1);
    expect(n.reason).toBe('too_large');
    expect(n.text).toMatch(/larger than 16 MiB/);
    expect(n.text).not.toMatch(/permission/);
  });
  it('M2-07: the message text is never parsed — only detail.reason counts', () => {
    // Words that used to steer the old regexes, with reasons that say otherwise.
    expect(
      readOnlyNotice([p('house_invalid', 'unreadableNote: Extra inputs', 'invalid')], 1).reason,
    ).toBe('invalid');
    expect(
      readOnlyNotice([p('house_invalid', 'schemaVersion: fine; grid: bad', 'invalid')], 1).reason,
    ).toBe('invalid');
    expect(readOnlyNotice([p('house_invalid', 'permission denied', 'unreadable')], 1).reason).toBe(
      'unreadable',
    );
  });
  it('a missing or unknown reason (older or newer backend) counts as invalid', () => {
    expect(readOnlyNotice([p('house_invalid', "can't be read")], 1).reason).toBe('invalid');
    expect(readOnlyNotice([p('house_invalid', 'x', 'disk_on_fire')], 1).reason).toBe('invalid');
  });
  it('never guesses while the report is loading', () => {
    expect(readOnlyNotice(null, 1).text).toBe('The house layout is read-only.');
  });
});
