/**
 * Coordinate conventions (DESIGN 15.16, data contract §2.2). Written down once, here.
 *
 * - Tile `(x, y)` covers `[x, x+1) × [y, y+1)` in tile units (× tileSize metres).
 * - The origin is the north-west corner of the grid. **+x is east, +y is south.**
 * - The 2D plan draws +y downwards (SVG), so plan coordinates are tile units × a pixel scale.
 * - three.js (milestone 2): `house.x → three.x`, `house.y → three.z`, up is `three.y`. With the
 *   default camera looking north, +y (south) points towards the viewer.
 * - Rotation is in degrees, clockwise seen from above. At 0 the item's front faces south and
 *   its back is against the north edge.
 * - Footprint anchor: `(x, y)` is the minimum corner of the occupied rectangle *after*
 *   rotation; 90 and 270 swap `w` and `d`.
 * - Openings sit on edges and have one key each: `n` is the edge between `(x, y)` and
 *   `(x, y−1)`, `w` the edge between `(x, y)` and `(x−1, y)`.
 */

export interface Cell {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A straight edge in tile units. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Rotation = 0 | 90 | 180 | 270;
export type Side = 'n' | 'e' | 's' | 'w';
export type Compass = 'north' | 'east' | 'south' | 'west';

export const cellKey = (x: number, y: number): string => `${x},${y}`;

const CELL_KEY = /^(0|[1-9]\d*),(0|[1-9]\d*)$/u;

/** Canonical `"x,y"` keys only (the API normalises loose keys before serving them). */
export function parseCellKey(key: string): Cell | null {
  const m = CELL_KEY.exec(key);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

export const cellCenter = ({ x, y }: Cell): { x: number; y: number } => ({
  x: x + 0.5,
  y: y + 0.5,
});

/** Occupied rectangle of a placement: anchor is the minimum corner after rotation. */
export function occupiedRect(
  x: number,
  y: number,
  rotation: number,
  footprint: readonly [number, number] = [1, 1],
): Rect {
  const [w, d] = footprint;
  const swap = rotation === 90 || rotation === 270;
  return { x, y, w: swap ? d : w, h: swap ? w : d };
}

const FACING: Record<Rotation, Compass> = { 0: 'south', 90: 'west', 180: 'north', 270: 'east' };
const BACK: Record<Rotation, Side> = { 0: 'n', 90: 'e', 180: 's', 270: 'w' };

const asRotation = (r: number): Rotation =>
  ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as Rotation;

/** Direction the item's front faces. */
export const facing = (rotation: number): Compass => FACING[asRotation(rotation)];

/** Edge the item's back is against; wall-mounted items hang on this edge. */
export const backEdge = (rotation: number): Side => BACK[asRotation(rotation)];

/** The edge an opening sits on, in tile units. */
export function openingSegment(o: { x: number; y: number; side: 'n' | 'w' }): Segment {
  return o.side === 'n'
    ? { x1: o.x, y1: o.y, x2: o.x + 1, y2: o.y }
    : { x1: o.x, y1: o.y, x2: o.x, y2: o.y + 1 };
}

/** The two tiles an opening separates: [the tile it is keyed on, its north/west neighbour]. */
export function openingCells(o: { x: number; y: number; side: 'n' | 'w' }): [Cell, Cell] {
  return [{ x: o.x, y: o.y }, o.side === 'n' ? { x: o.x, y: o.y - 1 } : { x: o.x - 1, y: o.y }];
}

/** World position of a tile centre for the 3D view: `((x+.5)·s, 0, (y+.5)·s)`. */
export function tileCenterWorld(
  { x, y }: Cell,
  tileSize: number,
): { x: number; y: number; z: number } {
  return { x: (x + 0.5) * tileSize, y: 0, z: (y + 0.5) * tileSize };
}
