import { describe, expect, it } from 'vitest';
import { printPageOf, printPath } from '../print/pages';
import { QUIET, qrPath, stickerUrl } from './qr';

describe('QR stickers (D45)', () => {
  it('draws the code as one path with a 4-module quiet zone', () => {
    const qr = qrPath('https://house.example/i/it_7f3k2a');
    // Version 3 (29 modules) holds this URL at level M; plus the quiet zone on both sides.
    expect(qr.size).toBe(29 + 2 * QUIET);
    // The top-left finder pattern starts with a full 7-module run at the quiet zone's corner.
    expect(qr.d.startsWith(`M${QUIET} ${QUIET}h7v1h-7z`)).toBe(true);
    expect(qrPath('https://house.example/i/it_7f3k2a')).toEqual(qr); // deterministic
    expect(qrPath('https://house.example/i/it_000000').d).not.toBe(qr.d);
  });

  it('links to the item’s deep link on this address', () => {
    expect(stickerUrl('https://house.example', 'it_7f3k2a')).toBe(
      'https://house.example/i/it_7f3k2a',
    );
    expect(stickerUrl('http://192.168.1.5:8080/', 'it_a b')).toBe(
      'http://192.168.1.5:8080/i/it_a%20b',
    );
  });

  it('print pages: which path is which, and preselected items', () => {
    expect(printPageOf('/print/emergency')).toBe('emergency');
    expect(printPageOf('/print/stickers/')).toBe('stickers');
    expect(printPageOf('/print/other')).toBeNull();
    expect(printPageOf('/i/it_7f3k2a')).toBeNull();
    expect(printPath('stickers')).toBe('/print/stickers');
    expect(printPath('stickers', ['it_a', 'it_b'])).toBe('/print/stickers?items=it_a,it_b');
    expect(printPath('stickers', [])).toBe('/print/stickers?items='); // none
  });
});
