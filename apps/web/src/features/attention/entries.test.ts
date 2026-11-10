import { describe, expect, it } from 'vitest';
import type { Status } from '../../domain/status';
import { makeItem, snapshot } from '../../test/fixtures';
import { attentionCount, attentionEntries, entryText } from './entries';

const check = (state: 'overdue' | 'due_soon' | 'scheduled', date: string, days: number) => ({
  state,
  date,
  days,
  derived: false,
});
const warranty = (state: 'expired' | 'ending' | 'active', date: string, days: number) => ({
  state,
  date,
  days,
});

describe('attentionEntries', () => {
  const a = makeItem({ id: 'a', name: 'Boiler' });
  const b = makeItem({ id: 'b', name: 'Alarm' });
  const c = makeItem({ id: 'c', name: 'Cooker' });
  const d = makeItem({ id: 'd', name: 'Dryer' });
  const statuses: Record<string, Status> = {
    // Overdue check and an ending warranty: two entries.
    a: {
      level: 'overdue',
      check: check('overdue', '2026-10-01', -34),
      warranty: warranty('ending', '2026-12-20', 46),
    },
    b: { level: 'overdue', check: check('overdue', '2026-10-20', -15), warranty: null },
    c: {
      level: 'due_soon',
      check: check('due_soon', '2026-11-10', 6),
      warranty: warranty('active', '2028-01-01', 800),
    },
    // Nothing to do: scheduled check, expired warranty.
    d: {
      level: null,
      check: check('scheduled', '2027-03-01', 117),
      warranty: warranty('expired', '2025-01-01', -672),
    },
  };
  const result = attentionEntries([a, b, c, d], (i) => statuses[i.id]!);

  it('puts overdue checks first, longest overdue first', () => {
    expect(result.overdue.map((e) => e.key)).toEqual(['a:check', 'b:check']);
    expect(result.overdue.every((e) => e.kind === 'check_overdue')).toBe(true);
  });

  it('lists due checks and ending warranties together by date, one entry each', () => {
    expect(result.upcoming.map((e) => [e.key, e.kind])).toEqual([
      ['c:check', 'check_due'],
      ['a:warranty', 'warranty_ending'],
    ]);
  });

  it('leaves out scheduled checks and active or expired warranties', () => {
    const keys = [...result.overdue, ...result.upcoming].map((e) => e.key);
    expect(keys.some((k) => k.startsWith('d:') || k === 'c:warranty')).toBe(false);
  });

  it('sorts the same date by name', () => {
    const same = (id: string, name: string) => makeItem({ id, name });
    const s: Status = {
      level: 'due_soon',
      check: check('due_soon', '2026-11-10', 6),
      warranty: null,
    };
    const r = attentionEntries([same('x', 'Zeta'), same('y', 'alpha')], () => s);
    expect(r.upcoming.map((e) => e.item.name)).toEqual(['alpha', 'Zeta']);
  });

  it('says what is due in words', () => {
    const [overdue] = result.overdue;
    expect(entryText(overdue!)).toBe('Check overdue by 34 days');
    expect(entryText({ ...overdue!, days: -1 })).toBe('Check overdue by 1 day');
    expect(entryText(result.upcoming[0]!)).toBe('Check due in 6 days');
    expect(entryText({ ...result.upcoming[0]!, days: 0 })).toBe('Check due today');
    expect(entryText(result.upcoming[1]!)).toBe('Warranty ends in 46 days');
    expect(entryText({ ...result.upcoming[1]!, days: 0 })).toBe('Warranty ends today');
  });
});

describe('attentionCount', () => {
  it('counts items, not entries, for today', () => {
    // Today = the snapshot's day: the dishwasher (overdue check, ending warranty) is one item.
    const now = new Date(`${snapshot.today}T12:00:00Z`);
    const count = attentionCount(snapshot, now);
    expect(count).toBe(1);
  });
});
