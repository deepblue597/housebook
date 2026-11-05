import { describe, expect, it } from 'vitest';
import { dishwasher, snapshot } from '../test/fixtures';
import { currentStatus, statusChips } from './status';

describe('currentStatus', () => {
  it('uses the server status while the snapshot is from today', () => {
    expect(currentStatus(dishwasher, snapshot, new Date('2026-11-04T10:00:00Z'))).toBe(
      dishwasher.status,
    );
  });
  it('recomputes with the shared rules once the day has changed', () => {
    const s = currentStatus(dishwasher, snapshot, new Date('2026-11-06T10:00:00Z'));
    expect(s.check).toMatchObject({ state: 'overdue', days: -5 });
    expect(s.warranty).toMatchObject({ state: 'ending', days: 25 });
  });
  it('words every state', () => {
    expect(statusChips(dishwasher.status).map((c) => c.text)).toEqual([
      'Check overdue by 3 days',
      'Warranty ends in 27 days',
    ]);
  });
});
