import { describe, expect, it } from 'vitest';
import { formatSize, manualSearchUrl } from './links';

describe('details helpers', () => {
  it('builds a manual search only when there is a brand or model', () => {
    expect(manualSearchUrl('Bosch', 'SMS4HVI33E')).toBe(
      'https://www.google.com/search?q=Bosch%20SMS4HVI33E%20manual%20pdf',
    );
    expect(manualSearchUrl(null, 'Ei650')).toBe(
      'https://www.google.com/search?q=Ei650%20manual%20pdf',
    );
    expect(manualSearchUrl(null, '')).toBeNull();
  });
  it('formats sizes', () => {
    expect([formatSize(622), formatSize(2048), formatSize(3.5 * 1024 * 1024)]).toEqual([
      '622 B',
      '2 KB',
      '3.5 MB',
    ]);
  });
});
