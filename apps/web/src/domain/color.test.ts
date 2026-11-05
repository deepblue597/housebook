import { describe, expect, it } from 'vitest';
import { blend, bestTextColor, contrastRatio, parseHex } from './color';

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
  });

  it('picks the readable colour over any translucent room tile', () => {
    const ink = { rgb: parseHex('#E0E9E7')!, name: 'ink' };
    const paper = { rgb: parseHex('#151E22')!, name: 'paper' };
    for (const room of ['#FFFFFF', '#000000', '#E3A94B', '#6BA7D6']) {
      const bg = blend(parseHex(room)!, paper.rgb, 0.4);
      const pick = bestTextColor(bg, [
        ink,
        paper,
        { rgb: [0, 0, 0] as const, name: 'black' },
        { rgb: [255, 255, 255] as const, name: 'white' },
      ]);
      expect(contrastRatio(pick.rgb, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
