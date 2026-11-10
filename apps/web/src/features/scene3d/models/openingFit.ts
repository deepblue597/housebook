/**
 * Fitting door and window models into their wall gaps (D37), as plain numbers so it is
 * unit-tested without WebGL. Unlike items (fitModel, proportions kept), these are stretched to
 * the gap: a door frame fills it exactly, whatever the tile size and wall thickness.
 *
 * Everything is in the opening's own frame (OpeningPlacement): origin on the wall line at
 * floor level, +x along the wall, +z across it. A Stretch maps a model point p to
 * p * scale + offset, per axis.
 */
import type { OpeningPlacement, Vec3 } from '../../../domain/scene';
import type { Bounds } from './normalise';

export interface Stretch {
  scale: Vec3;
  offset: Vec3;
}

/** How far a door stands open: wide enough to read as a door from above, short of the wall. */
export const DOOR_OPEN = (70 * Math.PI) / 180;
/** Door frame trim standing proud of the wall on each side (m). */
export const FRAME_TRIM = 0.02;
/** Window frame depth as a share of the wall's thickness: set in, so the reveal shows. */
export const WINDOW_DEPTH = 0.6;

const EPS = 1e-9;

/** Scale and offset that make bounds `b` fill a box of `size` centred on `centre`. */
export function stretchInto(b: Bounds, size: Vec3, centre: Vec3): Stretch {
  const axis = (k: 'x' | 'y' | 'z') => {
    const s = size[k] / Math.max(b.max[k] - b.min[k], EPS);
    return { s, o: centre[k] - ((b.min[k] + b.max[k]) / 2) * s };
  };
  const [x, y, z] = [axis('x'), axis('y'), axis('z')];
  return { scale: { x: x.s, y: y.s, z: z.s }, offset: { x: x.o, y: y.o, z: z.o } };
}

/** Where a point lands after `t` (tests and checks). */
export const applyStretch = (p: Vec3, t: Stretch): Vec3 => ({
  x: p.x * t.scale.x + t.offset.x,
  y: p.y * t.scale.y + t.offset.y,
  z: p.z * t.scale.z + t.offset.z,
});

export interface DoorFit {
  frame: Stretch;
  /** The leaf turns by `rotationY` about a vertical hinge through (x, z). */
  hinge: { x: number; z: number; rotationY: number };
  /** The leaf model in the hinge's frame: its hinge edge on the axis, closed along +x. */
  leaf: Stretch;
}

/**
 * A door: the frame (model bounds `frame`) stretched to the gap, full door height and a little
 * deeper than the wall; the leaf (authored inside the same frame, bounds `leaf`) scaled with
 * the frame along the wall and up, but keeping its own thickness ratio across (a thin wall
 * would otherwise make a paper door, a thick one a slab). It is hinged on its low-x edge, like
 * the 2D plan's door, and opened `DOOR_OPEN` towards `swing`.
 */
export function doorFit(frame: Bounds, leaf: Bounds, p: OpeningPlacement): DoorFit {
  const f = stretchInto(
    frame,
    { x: p.width, y: p.y1 - p.y0, z: p.thickness + 2 * FRAME_TRIM },
    { x: 0, y: (p.y0 + p.y1) / 2, z: 0 },
  );
  const s = f.scale.x;
  const leafMidZ = (leaf.min.z + leaf.max.z) / 2;
  return {
    frame: f,
    // A turn of +θ about y takes +x towards −z (three.js), so open towards +z is −θ.
    hinge: { x: leaf.min.x * s + f.offset.x, z: 0, rotationY: -p.swing * DOOR_OPEN },
    leaf: {
      scale: { x: s, y: f.scale.y, z: s },
      offset: { x: -leaf.min.x * s, y: f.offset.y, z: -leafMidZ * s },
    },
  };
}

/** A window: the frame and pane stretched to the gap between sill and head, set into the wall. */
export function windowFit(model: Bounds, p: OpeningPlacement): Stretch {
  return stretchInto(
    model,
    { x: p.width, y: p.y1 - p.y0, z: p.thickness * WINDOW_DEPTH },
    { x: 0, y: (p.y0 + p.y1) / 2, z: 0 },
  );
}
