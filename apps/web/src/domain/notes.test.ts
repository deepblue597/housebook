import { describe, expect, it } from 'vitest';
import { lastServiceDate } from './notes';

describe('maintenance log', () => {
  it('returns the latest dated entry under the heading', () => {
    const body =
      '## Maintenance log\n- 2026-03-02 Descaled\n- 2026-09-15 Pump\n- 2026-02-30 bad date\n\n## Notes\n- 2027-01-01 not a log entry';
    expect(lastServiceDate(body)).toBe('2026-09-15');
  });
  it('is null without a log', () => {
    expect(lastServiceDate('## Quick help\n- 2026-01-01 x')).toBeNull();
  });
});
