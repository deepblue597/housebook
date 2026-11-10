import { describe, expect, it } from 'vitest';
import { cellKey } from '../../../domain/coords';
import type { CellMap } from '../../../domain/plan';
import {
  DOOR_HEAD,
  OPENING_INSET,
  type OpeningPlacement,
  WINDOW_HEAD,
  WINDOW_SILL,
  openingPlacements,
  wallThickness,
} from '../../../domain/scene';
import { walls } from '../../../domain/plan';
import { DOOR_OPEN, FRAME_TRIM, applyStretch, doorFit, windowFit } from './openingFit';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

/** Two rooms side by side: a (0..1, 0..0) and b (2, 0), i.e. tiles (0,0) (1,0) | (2,0). */
function twoRooms(): CellMap {
  return new Map([
    [cellKey(0, 0), 'a'],
    [cellKey(1, 0), 'a'],
    [cellKey(2, 0), 'b'],
  ]);
}

const FRAME = { min: { x: 0, y: 0, z: -0.9 }, max: { x: 4.86, y: 10.1, z: 0 } };
const LEAF = { min: { x: 0.28, y: 0, z: -0.65 }, max: { x: 4.58, y: 9.8, z: -0.24 } };

describe('openingPlacements', () => {
  const cells = twoRooms();
  const w = walls(cells);

  it('places a door between two rooms on the interior wall, swinging into the keyed tile', () => {
    const [p] = openingPlacements(w, [{ x: 2, y: 0, side: 'w', kind: 'door' }], cells, 1, 2.5);
    expect(p).toMatchObject({ kind: 'door', exterior: false, x: 2, z: 0.5, y0: 0, y1: DOOR_HEAD });
    close(p!.width, 1 - 2 * OPENING_INSET);
    close(p!.thickness, wallThickness('interior', 1));
    close(p!.rotationY, -Math.PI / 2);
    // The keyed tile (2, 0) is east, which is local −z on a `w` edge.
    expect(p!.swing).toBe(-1);
  });

  it('a window on the outside wall sits between sill and head, or in the upper half of a low wall', () => {
    const o = [{ x: 0, y: 0, side: 'n' as const, kind: 'window' }];
    const [up] = openingPlacements(w, o, cells, 1, 2.5);
    expect(up).toMatchObject({ exterior: true, x: 0.5, z: 0, rotationY: 0, y0: WINDOW_SILL });
    expect(up!.y1).toBe(WINDOW_HEAD);
    // North of (0, 0) is outside, so the door would swing into the keyed tile, south (+z).
    expect(up!.swing).toBe(1);
    const [cut] = openingPlacements(w, o, cells, 1, 0.3);
    close(cut!.y0, 0.15);
    close(cut!.y1, 0.3);
  });

  it('skips openings that are not on a wall', () => {
    expect(openingPlacements(w, [{ x: 1, y: 0, side: 'w', kind: 'door' }], cells, 1, 2.5)).toEqual(
      [],
    );
  });
});

describe('doorFit / windowFit', () => {
  const p: OpeningPlacement = {
    key: '2,0,w',
    kind: 'door',
    exterior: false,
    x: 2,
    z: 0.5,
    rotationY: 0,
    width: 0.76,
    thickness: 0.1,
    y0: 0,
    y1: DOOR_HEAD,
    swing: 1,
  };

  it('stretches the frame to fill the gap, a little deeper than the wall', () => {
    const f = doorFit(FRAME, LEAF, p).frame;
    const lo = applyStretch(FRAME.min, f);
    const hi = applyStretch(FRAME.max, f);
    close(lo.x, -0.38);
    close(hi.x, 0.38);
    close(lo.y, 0);
    close(hi.y, DOOR_HEAD);
    close(hi.z - lo.z, 0.1 + 2 * FRAME_TRIM);
    close((hi.z + lo.z) / 2, 0);
  });

  it('hinges the leaf on its low-x edge and opens it towards the swing side', () => {
    const fit = doorFit(FRAME, LEAF, p);
    // In the hinge frame, the leaf starts on the axis and runs along +x, centred across.
    const a = applyStretch(LEAF.min, fit.leaf);
    const b = applyStretch(LEAF.max, fit.leaf);
    close(a.x, 0);
    close((a.z + b.z) / 2, 0);
    // The hinge is where the closed leaf's edge was inside the frame.
    close(fit.hinge.x, applyStretch(LEAF.min, fit.frame).x);
    // Swing +1 opens towards +z: a turn of −DOOR_OPEN takes +x to (cos, +sin).
    close(fit.hinge.rotationY, -DOOR_OPEN);
    close(doorFit(FRAME, LEAF, { ...p, swing: -1 }).hinge.rotationY, DOOR_OPEN);
  });

  it('fits a window between sill and head, set into the wall', () => {
    const win = { ...p, kind: 'window' as const, y0: WINDOW_SILL, y1: WINDOW_HEAD };
    const f = windowFit(FRAME, win);
    close(applyStretch(FRAME.min, f).y, WINDOW_SILL);
    close(applyStretch(FRAME.max, f).y, WINDOW_HEAD);
    expect(applyStretch(FRAME.max, f).z - applyStretch(FRAME.min, f).z).toBeLessThan(0.1);
  });
});
