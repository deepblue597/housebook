import { describe, expect, it } from 'vitest';
import {
  backEdge,
  facing,
  occupiedRect,
  openingCells,
  openingSegment,
  parseCellKey,
  tileCenterWorld,
} from './coords';

describe('coordinate conventions (data contract §2.2)', () => {
  it('parses canonical cell keys only', () => {
    expect(parseCellKey('12,3')).toEqual({ x: 12, y: 3 });
    expect(parseCellKey('01,0')).toBeNull();
    expect(parseCellKey(' 1,0')).toBeNull();
    expect(parseCellKey('-1,0')).toBeNull();
  });

  it.each([
    [0, 'south', 'n'],
    [90, 'west', 'e'],
    [180, 'north', 's'],
    [270, 'east', 'w'],
  ] as const)('rotation %i faces %s, back against %s', (r, front, back) => {
    expect(facing(r)).toBe(front);
    expect(backEdge(r)).toBe(back);
  });

  it('swaps the footprint for 90 and 270', () => {
    expect(occupiedRect(2, 3, 0, [2, 1])).toEqual({ x: 2, y: 3, w: 2, h: 1 });
    expect(occupiedRect(2, 3, 90, [2, 1])).toEqual({ x: 2, y: 3, w: 1, h: 2 });
  });

  it('keys openings on n and w edges', () => {
    expect(openingSegment({ x: 8, y: 5, side: 'n' })).toEqual({ x1: 8, y1: 5, x2: 9, y2: 5 });
    expect(openingSegment({ x: 7, y: 5, side: 'w' })).toEqual({ x1: 7, y1: 5, x2: 7, y2: 6 });
    expect(openingCells({ x: 7, y: 5, side: 'w' })[1]).toEqual({ x: 6, y: 5 });
  });

  it('maps house y to three.js z', () => {
    expect(tileCenterWorld({ x: 1, y: 2 }, 0.5)).toEqual({ x: 0.75, y: 0, z: 1.25 });
  });
});
