import { describe, expect, it } from 'vitest';
import { dataTime } from './dataTime';

describe('dataTime', () => {
  const now = new Date(2026, 10, 13, 18, 30);
  it('shows only the time for today', () => {
    expect(dataTime(new Date(2026, 10, 13, 9, 5), now, 'en-GB')).toBe('09:05');
  });
  it('adds the date for another day', () => {
    expect(dataTime(new Date(2026, 10, 12, 9, 5), now, 'en-GB')).toBe('12 Nov 2026, 09:05');
  });
});
