import { describe, expect, it } from 'vitest';
import { isWebUrl, safeExternalHref, safeHref } from './urls';

describe('URL allowlist (DESIGN 15.13)', () => {
  it.each([
    'https://example.com/x',
    'http://example.com',
    'mailto:a@b.c',
    'tel:+30210',
    'obsidian://open?vault=v&file=f',
    '/i/it_1',
    '#notes',
  ])('allows %s', (u) => expect(safeHref(u)).toBe(u));

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' java\tscript:alert(1)',
    'data:text/html,<script>',
    'vbscript:x',
    'file:///etc/passwd',
  ])('blocks %j', (u) => expect(safeHref(u)).toBeNull());

  it('requires an absolute URL for frontmatter links', () => {
    expect(safeExternalHref('/relative')).toBeNull();
    expect(safeExternalHref('https://bosch-home.gr/')).toBe('https://bosch-home.gr/');
  });

  it('treats protocol-relative URLs as external web links', () => {
    expect(safeHref('//example.com/x')).toBe('//example.com/x');
    expect(safeExternalHref('//example.com/x')).toBe('//example.com/x');
    expect(isWebUrl('//example.com/x')).toBe(true);
    expect(isWebUrl('/\\example.com')).toBe(true);
    expect(isWebUrl('/i/it_1')).toBe(false);
    expect(isWebUrl('mailto:a@b.c')).toBe(false);
  });
});
