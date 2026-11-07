import { describe, expect, it } from 'vitest';
import { fitView, minScale, twoFingerStep, zoomAt } from './usePanZoom';

const planPointAt = (v: { k: number; tx: number; ty: number }, x: number, y: number) => ({
  x: (x - v.tx) / v.k,
  y: (y - v.ty) / v.k,
});

describe('pan and zoom maths', () => {
  it('fits the bounds centred in the viewport', () => {
    const v = fitView({ x: 0, y: 0, w: 100, h: 50 }, 224, 224);
    expect(v.k).toBe(2);
    expect(v).toMatchObject({ tx: 12, ty: 62 });
  });

  it('zooms around a fixed screen point', () => {
    const v = { k: 1, tx: 10, ty: 20 };
    const z = zoomAt(v, 2, 100, 100);
    expect(planPointAt(z, 100, 100)).toEqual(planPointAt(v, 100, 100));
  });

  it('two fingers moving together pan without zooming', () => {
    const v = { k: 1.5, tx: 0, ty: 0 };
    const next = twoFingerStep(v, { x: 100, y: 100, d: 80 }, { x: 130, y: 90, d: 80 });
    expect(next).toEqual({ k: 1.5, tx: 30, ty: -10 });
  });

  it('a pinch keeps the plan point under the midpoint, even while the midpoint moves', () => {
    let v = { k: 1, tx: 5, ty: 7 };
    const anchor = planPointAt(v, 200, 150);
    let prev = { x: 200, y: 150, d: 80 };
    for (let i = 1; i <= 5; i++) {
      const cur = { x: 200 + 4 * i, y: 150 - 2 * i, d: 80 + 16 * i };
      v = twoFingerStep(v, prev, cur);
      prev = cur;
    }
    expect(v.k).toBeCloseTo(2, 10);
    const p = planPointAt(v, prev.x, prev.y);
    expect(p.x).toBeCloseTo(anchor.x, 10);
    expect(p.y).toBeCloseTo(anchor.y, 10);
  });
});

describe('minimum zoom (M5-06)', () => {
  it('Fit shows even a 512-tile grid', () => {
    const bounds = { x: 0, y: 0, w: 512 * 40, h: 512 * 40 };
    const v = fitView(bounds, 800, 600);
    expect(v.k * bounds.w).toBeLessThanOrEqual(800);
    expect(v.k * bounds.h).toBeLessThanOrEqual(600);
    expect(minScale(bounds, 800, 600)).toBeLessThanOrEqual(v.k);
    // Zooming out can't go below what Fit shows, and small houses keep the old limit.
    expect(zoomAt(v, 0.01, 0, 0, minScale(bounds, 800, 600)).k).toBeCloseTo(v.k);
    expect(minScale({ x: 0, y: 0, w: 400, h: 400 }, 800, 600)).toBe(0.2);
  });
});
