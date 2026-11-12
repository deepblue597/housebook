// Golden cases shared with the backend (pytest runs the same file).
import fixtures from '@contract/fixtures/status_cases.json';
import { describe, expect, it } from 'vitest';
import { todayIn } from './dates';
import {
  DUE_SOON_DAYS,
  WARRANTY_ENDING_DAYS,
  computeStatus,
  intervalText,
  parseInterval,
  suggestNextCheck,
} from './status';

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

describe('suggestNextCheck (D39)', () => {
  it('is the entry date plus the interval, months clamped to the month end', () => {
    expect(suggestNextCheck({ next_check: '2026-11-01', check_every: '6m' }, '2026-11-10')).toBe(
      '2027-05-10',
    );
    expect(suggestNextCheck({ next_check: '2026-01-01', check_every: '1m' }, '2026-01-31')).toBe(
      '2026-02-28',
    );
    expect(suggestNextCheck({ next_check: '2026-11-01', check_every: '2w' }, '2026-11-10')).toBe(
      '2026-11-24',
    );
  });
  it('needs a valid interval and an explicit next check', () => {
    expect(
      suggestNextCheck({ next_check: '2026-11-01', check_every: null }, '2026-11-10'),
    ).toBeNull();
    expect(
      suggestNextCheck({ next_check: '2026-11-01', check_every: 'often' }, '2026-11-10'),
    ).toBeNull();
    // Without next_check the date already follows the log (derived): nothing to set.
    expect(suggestNextCheck({ next_check: null, check_every: '1y' }, '2026-11-10')).toBeNull();
  });
  it('never moves the next check earlier (an old service logged late)', () => {
    expect(
      suggestNextCheck({ next_check: '2027-06-01', check_every: '1y' }, '2025-03-01'),
    ).toBeNull();
    expect(
      suggestNextCheck({ next_check: '2027-11-10', check_every: '1y' }, '2026-11-10'),
    ).toBeNull();
  });
});

describe('intervalText', () => {
  it('spells the interval out for "every …"', () => {
    expect(intervalText('1y')).toBe('year');
    expect(intervalText('6M')).toBe('6 months');
    expect(intervalText('2w')).toBe('2 weeks');
    expect(intervalText('10d')).toBe('10 days');
    expect(intervalText('often')).toBe('often');
  });
});
