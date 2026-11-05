// Golden cases shared with the backend (pytest runs the same file).
import fixtures from '@contract/fixtures/status_cases.json';
import { describe, expect, it } from 'vitest';
import { todayIn } from './dates';
import { DUE_SOON_DAYS, WARRANTY_ENDING_DAYS, computeStatus, parseInterval } from './status';

describe('status rules (contract/fixtures/status_cases.json)', () => {
  it('uses the same thresholds', () => {
    expect(DUE_SOON_DAYS).toBe(fixtures.rules.dueSoonDays);
    expect(WARRANTY_ENDING_DAYS).toBe(fixtures.rules.warrantyEndingDays);
  });

  it.each(fixtures.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(computeStatus(c.today, c.item)).toEqual(c.expect);
  });

  it.each(fixtures.today_cases.map((c) => [c.name, c] as const))('today: %s', (_name, c) => {
    expect(todayIn(c.tz, new Date(c.now))).toBe(c.today);
  });

  it.each(fixtures.interval_cases.map((c) => [JSON.stringify(c.input), c] as const))(
    'interval %s',
    (_name, c) => {
      expect(parseInterval(c.input) !== null).toBe(c.valid);
    },
  );
});
