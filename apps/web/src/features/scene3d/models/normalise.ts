/**
 * Fitting a model into an item's box (DESIGN §7.4, data contract §2.2), as plain numbers so it
 * is unit-tested without WebGL.
 *
 * The item's box is `size` (w along x, h along y, d along z), centred on the origin, front +z.
 * A model is scaled uniformly (proportions kept) to the largest size that fits the box, centred
 * across, and placed by mount: floor items stand on the box's bottom, wall items hang with their
 * top at the box's top (WALL_ITEM_TOP) and their back against the box's back (the wall side),
 * ceiling items hang with their top at the box's top (the ceiling).
 */
import type { Mount, Vec3 } from '../../../domain/scene';

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface Fit {
  /** Uniform scale applied to the model. */
  scale: number;
  /** Position of the (scaled) model's origin in the item's frame. */
  offset: Vec3;
}

/** Quarter turns only (models are authored on the axes). */
export type Yaw = 0 | 90 | 180 | 270;

/**
 * A point turned by `yaw` degrees about +y, the way three.js turns it (counter-clockwise seen
 * from above). Yaw 180 turns a model authored facing −z to face +z.
 */
export function yawPoint(p: Vec3, yaw: Yaw): Vec3 {
  switch (yaw) {
    case 0:
      return { ...p };
    case 90:
      return { x: p.z, y: p.y, z: -p.x };
    case 180:
      return { x: -p.x, y: p.y, z: -p.z };
    case 270:
      return { x: -p.z, y: p.y, z: p.x };
  }
}

/** The bounds of `b` after turning it by `yaw`. */
export function yawBounds(b: Bounds, yaw: Yaw): Bounds {
  const a = yawPoint(b.min, yaw);
  const c = yawPoint(b.max, yaw);
  return {
    min: { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), z: Math.min(a.z, c.z) },
    max: { x: Math.max(a.x, c.x), y: Math.max(a.y, c.y), z: Math.max(a.z, c.z) },
  };
}

const EPS = 1e-9;

/** Scale and offset that fit model bounds `b` (already facing +z) into the item box `size`. */
export function fitModel(b: Bounds, size: Vec3, mount: Mount): Fit {
  const bw = Math.max(b.max.x - b.min.x, EPS);
  const bh = Math.max(b.max.y - b.min.y, EPS);
  const bd = Math.max(b.max.z - b.min.z, EPS);
  const s = Math.min(size.x / bw, size.y / bh, size.z / bd);
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const y = mount === 'floor' ? -size.y / 2 - b.min.y * s : size.y / 2 - b.max.y * s;
  const z = mount === 'wall' ? -size.z / 2 - b.min.z * s : -cz * s;
  return { scale: s, offset: { x: -cx * s, y, z } };
}

/** Bounds of `b` after `fit` (for tests and the hit box). */
export function fittedBounds(b: Bounds, fit: Fit): Bounds {
  const t = (p: Vec3): Vec3 => ({
    x: p.x * fit.scale + fit.offset.x,
    y: p.y * fit.scale + fit.offset.y,
    z: p.z * fit.scale + fit.offset.z,
  });
  return { min: t(b.min), max: t(b.max) };
}
