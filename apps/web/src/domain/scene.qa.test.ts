/**
 * QA re-verification of the M2 wall changes (DESIGN §7.4 / D18), with expectations written from
 * the example house's cell map, not from the implementation:
 *
 *   y 1-4: Living x1-6 | Kitchen x7-10 | Bedroom x11-14
 *   y 5:   Living x1-6 | Hallway x7-14
 *   y 6-8: Living/Balcony x1-6 | Office x7-10 | Bathroom x11-13 | Utility x14
 */
import { describe, expect, it } from 'vitest';
import { cellKey } from './coords';
import { walls } from './plan';
import {
  CEILING_HEIGHT,
  CUT_HEIGHT,
  WALL_ITEM_TOP,
  facingWalls,
  mountCentreY,
  wallGeometry,
} from './scene';
import type { Heading } from './scene';
import { house } from '../test/exampleHouse';

const cells = new Map(Object.entries(house.floors[0]!.cells ?? {}));
const w = walls(cells);

/** Is the unit edge starting at `u` on line `line` in this list of segments? */
const covers = (
  segs: readonly { x1: number; y1: number; x2: number; y2: number }[],
  horizontal: boolean,
  line: number,
  u: number,
) =>
  segs.some((s) =>
    horizontal
      ? s.y1 === line && s.y2 === line && Math.min(s.x1, s.x2) <= u && Math.max(s.x1, s.x2) >= u + 1
      : s.x1 === line &&
        s.x2 === line &&
        Math.min(s.y1, s.y2) <= u &&
        Math.max(s.y1, s.y2) >= u + 1,
  );
const facing = (h: Heading) => {
  const f = facingWalls(w, cells, h).facing;
  return [...f.interior, ...f.exterior];
};
const other = (h: Heading) => {
  const o = facingWalls(w, cells, h).other;
  return [...o.interior, ...o.exterior];
};

describe('walls up: which walls fade (they stand between the camera and a room)', () => {
  it('looking north: the near (south) exterior wall and kitchen/hallway wall fade; the far north wall stays', () => {
    expect(covers(facing('north'), true, 9, 8)).toBe(true); // south exterior, below the Office
    expect(covers(facing('north'), true, 5, 8)).toBe(true); // Kitchen | Hallway
    expect(covers(other('north'), true, 1, 8)).toBe(true); // north exterior: hides nothing
    expect(covers(facing('north'), true, 1, 8)).toBe(false);
    // North–south walls run along the view and never fade looking north.
    expect(covers(other('north'), false, 7, 2)).toBe(true); // Living | Kitchen
  });

  it('looking south it flips: the north exterior wall fades, the south one stays', () => {
    expect(covers(facing('south'), true, 1, 8)).toBe(true);
    expect(covers(other('south'), true, 9, 8)).toBe(true);
    expect(covers(facing('south'), true, 6, 8)).toBe(true); // Hallway | Office
  });

  it('looking west the east exterior wall fades; looking east the west one does', () => {
    expect(covers(facing('west'), false, 15, 2)).toBe(true); // east exterior beside the Bedroom
    expect(covers(other('west'), false, 1, 2)).toBe(true); // west exterior: far side, stays
    expect(covers(facing('east'), false, 1, 2)).toBe(true);
    expect(covers(other('east'), false, 15, 2)).toBe(true);
    expect(covers(facing('west'), false, 11, 2)).toBe(true); // Kitchen | Bedroom
    // East–west walls run along the view looking west.
    expect(covers(other('west'), true, 5, 8)).toBe(true);
  });

  it('every wall edge is in exactly one of facing/other at each heading', () => {
    const total = (segs: readonly { x1: number; y1: number; x2: number; y2: number }[]) =>
      segs.reduce((n, s) => n + Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 0);
    const all = total([...w.interior, ...w.exterior]);
    for (const h of ['north', 'east', 'south', 'west'] as const)
      expect(total(facing(h)) + total(other(h)), h).toBe(all);
  });
});

describe('window dips (cut-away walls still show windows)', () => {
  // A single 1-tile room with a window on its north edge.
  const one = new Map([[cellKey(0, 0), 'r']]);
  const win = [{ x: 0, y: 0, side: 'n' as const, kind: 'window' }];
  it('cut-away: the window span drops to half the wall with a pane above it', () => {
    const g = wallGeometry(walls(one), win, 1, CUT_HEIGHT);
    const north = g.walls.filter((b) => Math.abs(b.z) < 1e-9 && b.sx < 0.9);
    const dip = north.find((b) => b.x > 0.2 && b.x < 0.8)!;
    expect(dip.y + dip.sy / 2).toBeCloseTo(CUT_HEIGHT / 2, 6);
    expect(g.glass).toHaveLength(1);
    expect(g.glass[0]!.y - g.glass[0]!.sy / 2).toBeCloseTo(CUT_HEIGHT / 2, 6);
    expect(g.glass[0]!.y + g.glass[0]!.sy / 2).toBeCloseTo(CUT_HEIGHT, 6);
  });
});

describe('mount heights do not depend on the wall height', () => {
  it('wall items top out at 1.8 m and ceiling items hang at the ceiling, walls up or not', () => {
    for (const h of [0.1, 0.5, 0.9]) {
      expect(mountCentreY('wall', h) + h / 2).toBeCloseTo(WALL_ITEM_TOP, 6);
      expect(mountCentreY('ceiling', h) + h / 2).toBeCloseTo(CEILING_HEIGHT, 6);
      expect(mountCentreY('floor', h) - h / 2).toBeCloseTo(0, 6);
    }
  });
});
