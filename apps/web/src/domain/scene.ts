/**
 * Geometry for the 3D view (DESIGN §7.4), as plain numbers: no three.js, so it is unit-tested
 * without WebGL and the 3D chunk only wraps it in BufferGeometry.
 *
 * World units are metres. Mapping (data contract §2.2, coords.ts): house x → three x,
 * house y → three z, up is three y; a tile (x, y) covers [x, x+1) × [y, y+1) × tileSize.
 */
import {
  type Cell,
  type PointerCell,
  type Rect,
  type Segment,
  backEdge,
  cellKey,
  occupiedRect,
} from './coords';
import type { CellMap, Walls } from './plan';

/** The compass direction the camera looks. */
export type Heading = 'north' | 'east' | 'south' | 'west';

export type Mount = 'floor' | 'wall' | 'ceiling';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Full room height ("walls up"). */
export const CEILING_HEIGHT = 2.5;
/**
 * Default cut-away wall height: low enough that at the 45° view no tile or item is hidden behind
 * a wall (M2-03), high enough that rooms stay outlined.
 */
export const CUT_HEIGHT = 0.3;
/**
 * Top of a wall-mounted model above the floor (DESIGN §7.4: ~1.8 m). Fixed, whatever the wall
 * height shown: toggling "walls up" never moves an item; above a low cut-away wall it floats.
 */
export const WALL_ITEM_TOP = 1.8;
export const DOOR_HEAD = 2.1;
export const WINDOW_SILL = 0.9;
export const WINDOW_HEAD = 2.1;
/** Gap between a wall item's back and the wall line (≥ half the thickest wall). */
export const WALL_GAP = 0.1;
/** Openings leave this much wall at each end of their edge, in tiles (as in the 2D plan). */
export const OPENING_INSET = 0.12;

export const wallThickness = (kind: 'interior' | 'exterior', tileSize: number): number =>
  Math.min(kind === 'exterior' ? 0.2 : 0.1, tileSize / 4);

// ---- items ---------------------------------------------------------------------------

/** Placeholder model size per type (milestone 3 swaps in real models with their own size). */
export interface ItemShape {
  /** Height in metres. */
  height: number;
  /** Depth in metres for wall and ceiling items (floor items fill their footprint). */
  depth?: number;
  /** Share of the footprint the model covers, so neighbours don't touch (default 0.8). */
  fill?: number;
}

export interface ItemTransform {
  /** Centre of the model's bounding box, world metres. */
  position: Vec3;
  /** three.js rotation.y: −rotation · π/180 (rotation is clockwise seen from above). */
  rotationY: number;
  /** Model size in its own frame before rotation: w along x, h along y, d along z (front +z). */
  size: Vec3;
  /** Footprint in the model's own frame, metres (x along w, z along d). */
  footprint: { x: number; z: number };
  /** Occupied tiles after rotation (anchor = min corner). */
  rect: Rect;
}

const BACK_DIR = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] } as const;

/**
 * Centre height of a model of height `h` for its mount, at its real height whatever the wall
 * height shown (no jump when toggling "walls up"): wall items with their top at WALL_ITEM_TOP,
 * ceiling items under the ceiling.
 */
export function mountCentreY(mount: Mount, h: number): number {
  if (mount === 'floor') return h / 2;
  if (mount === 'ceiling') return Math.max(h / 2, CEILING_HEIGHT - h / 2);
  return Math.max(h / 2, WALL_ITEM_TOP - h / 2);
}

export function itemTransform(
  loc: { x: number; y: number; rotation: number },
  spec: { footprint: readonly [number, number]; mount: Mount },
  shape: ItemShape,
  tileSize: number,
): ItemTransform {
  const rect = occupiedRect(loc.x, loc.y, loc.rotation, spec.footprint);
  const fill = shape.fill ?? 0.8;
  const [fw, fd] = spec.footprint;
  const w = fw * tileSize * fill;
  const d =
    spec.mount === 'floor'
      ? fd * tileSize * fill
      : Math.min(shape.depth ?? fd * tileSize * fill, fd * tileSize * fill);
  const h = shape.height;
  let x = (rect.x + rect.w / 2) * tileSize;
  let z = (rect.y + rect.h / 2) * tileSize;
  if (spec.mount === 'wall') {
    // Back against the edge the rotation names (data contract §2.2).
    const [bx, bz] = BACK_DIR[backEdge(loc.rotation)];
    const shift = (fd * tileSize) / 2 - WALL_GAP - d / 2;
    x += bx * shift;
    z += bz * shift;
  }
  return {
    position: { x, y: mountCentreY(spec.mount, h), z },
    rotationY: loc.rotation === 0 ? 0 : (-loc.rotation * Math.PI) / 180,
    size: { x: w, y: h, z: d },
    footprint: { x: fw * tileSize, z: fd * tileSize },
    rect,
  };
}

// ---- picking -------------------------------------------------------------------------

/** The tile under a world point on the floor plane. */
export function worldToCell(x: number, z: number, tileSize: number): PointerCell {
  const gx = x / tileSize;
  const gy = z / tileSize;
  const cx = Math.floor(gx);
  const cy = Math.floor(gy);
  return { x: cx, y: cy, fx: gx - cx, fy: gy - cy };
}

/** The room under a world point, if any. */
export function roomAtPoint(
  cells: CellMap,
  x: number,
  z: number,
  tileSize: number,
): string | undefined {
  const c = worldToCell(x, z, tileSize);
  return cells.get(cellKey(c.x, c.y));
}

/** Tile-unit bounds of the painted cells, or the whole grid when nothing is painted. */
export function cellBounds(
  cells: CellMap,
  grid: { width: number; depth: number },
): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const key of cells.keys()) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  }
  return x0 === Infinity
    ? { x0: 0, y0: 0, x1: Math.max(1, grid.width), y1: Math.max(1, grid.depth) }
    : { x0, y0, x1, y1 };
}

// ---- walls ---------------------------------------------------------------------------

export interface Box {
  /** Centre. */
  x: number;
  y: number;
  z: number;
  /** Full size along each axis. */
  sx: number;
  sy: number;
  sz: number;
}

export interface OpeningLike {
  x: number;
  y: number;
  side: 'n' | 'w';
  kind: string;
}

export interface WallGeometry {
  /** Solid wall pieces (merged into one mesh per floor). */
  walls: Box[];
  /** Window panes, drawn translucent. */
  glass: Box[];
}

interface Piece {
  a: number;
  b: number;
  y0: number;
  y1: number;
  /** Extend this end by half the thickness to close corners (only at segment ends). */
  capA: boolean;
  capB: boolean;
}

/**
 * Wall boxes for one floor: every wall edge from `walls()` (the same edges the 2D plan draws)
 * becomes a box `height` tall, exterior walls thicker. Doors cut a gap (with a lintel when the
 * wall is taller than the door), windows leave a sill and a head with a pane between them.
 */
export function wallGeometry(
  w: Walls,
  openings: readonly OpeningLike[],
  tileSize: number,
  height: number,
): WallGeometry {
  const out: WallGeometry = { walls: [], glass: [] };
  const kinds: ['exterior' | 'interior', Segment[]][] = [
    ['exterior', w.exterior],
    ['interior', w.interior],
  ];
  for (const [kind, segs] of kinds) {
    const t = wallThickness(kind, tileSize);
    for (const s of segs) {
      const horizontal = s.y1 === s.y2;
      const line = horizontal ? s.y1 : s.x1;
      const a = Math.min(horizontal ? s.x1 : s.y1, horizontal ? s.x2 : s.y2);
      const b = Math.max(horizontal ? s.x1 : s.y1, horizontal ? s.x2 : s.y2);
      const holes = openings
        .filter((o) =>
          horizontal
            ? o.side === 'n' && o.y === line && o.x >= a && o.x < b
            : o.side === 'w' && o.x === line && o.y >= a && o.y < b,
        )
        .map((o) => {
          const at = horizontal ? o.x : o.y;
          return { a: at + OPENING_INSET, b: at + 1 - OPENING_INSET, kind: o.kind };
        })
        .sort((p, q) => p.a - q.a);

      const pieces: Piece[] = [];
      const glass: Piece[] = [];
      let cursor = a;
      for (const hole of holes) {
        if (hole.a > cursor)
          pieces.push({ a: cursor, b: hole.a, y0: 0, y1: height, capA: cursor === a, capB: false });
        const span = { a: hole.a, b: hole.b, capA: false, capB: false };
        if (hole.kind === 'window') {
          // A wall cut below the sill still shows the window, like the 2D plan's mark: a dip
          // to half the wall's height with the pane in it.
          const sill = height > WINDOW_SILL ? WINDOW_SILL : height / 2;
          pieces.push({ ...span, y0: 0, y1: sill });
          if (height > WINDOW_HEAD) pieces.push({ ...span, y0: WINDOW_HEAD, y1: height });
          glass.push({ ...span, y0: sill, y1: Math.min(height, WINDOW_HEAD) });
        } else if (height > DOOR_HEAD) {
          pieces.push({ ...span, y0: DOOR_HEAD, y1: height });
        }
        cursor = hole.b;
      }
      if (cursor < b)
        pieces.push({ a: cursor, b, y0: 0, y1: height, capA: cursor === a, capB: true });

      const toBox = (p: Piece, thick: number): Box => {
        const lo = p.a * tileSize - (p.capA ? t / 2 : 0);
        const hi = p.b * tileSize + (p.capB ? t / 2 : 0);
        const mid = (lo + hi) / 2;
        const len = hi - lo;
        const across = line * tileSize;
        const y = (p.y0 + p.y1) / 2;
        const sy = p.y1 - p.y0;
        return horizontal
          ? { x: mid, y, z: across, sx: len, sy, sz: thick }
          : { x: across, y, z: mid, sx: thick, sy, sz: len };
      };
      for (const p of pieces) if (p.y1 > p.y0) out.walls.push(toBox(p, t));
      for (const p of glass) out.glass.push(toBox(p, t * 0.3));
    }
  }
  return out;
}

/**
 * Walls with "walls up" (DESIGN §7.4): those that face a camera looking `heading` and hide room
 * tiles behind them are drawn faded. A wall faces the camera when it runs across the view
 * direction (east–west walls looking north or south, north–south walls looking east or west)
 * and the tile on its far side is part of a room. The far exterior wall hides nothing inside,
 * so it stays solid. Segments are split where that changes along them.
 */
export function facingWalls(
  w: Walls,
  cells: CellMap,
  heading: Heading,
): { facing: Walls; other: Walls } {
  const facing: Walls = { interior: [], exterior: [] };
  const other: Walls = { interior: [], exterior: [] };
  const lookNS = heading === 'north' || heading === 'south';
  for (const kind of ['interior', 'exterior'] as const) {
    for (const s of w[kind]) {
      const horizontal = s.y1 === s.y2;
      if (horizontal !== lookNS) {
        other[kind].push(s);
        continue;
      }
      const line = horizontal ? s.y1 : s.x1;
      const a = Math.min(horizontal ? s.x1 : s.y1, horizontal ? s.x2 : s.y2);
      const b = Math.max(horizontal ? s.x1 : s.y1, horizontal ? s.x2 : s.y2);
      // The far side is away from the camera: north of the line when looking north, etc.
      const far = heading === 'north' || heading === 'west' ? line - 1 : line;
      const hides = (u: number) => cells.has(horizontal ? cellKey(u, far) : cellKey(far, u));
      let start = a;
      for (let u = a + 1; u <= b; u++) {
        if (u < b && hides(u) === hides(start)) continue;
        const seg = horizontal
          ? { x1: start, y1: line, x2: u, y2: line }
          : { x1: line, y1: start, x2: line, y2: u };
        (hides(start) ? facing : other)[kind].push(seg);
        start = u;
      }
    }
  }
  return { facing, other };
}

/** The parts of `boxes` above height `y` (what is left of a wall above its lowered base). */
export function boxesAbove(boxes: readonly Box[], y: number): Box[] {
  return boxes.flatMap((b) => {
    const top = b.y + b.sy / 2;
    const bottom = Math.max(y, b.y - b.sy / 2);
    return top > bottom ? [{ ...b, y: (top + bottom) / 2, sy: top - bottom }] : [];
  });
}

// ---- mesh buffers --------------------------------------------------------------------

/** Indexed triangle data, ready for a BufferGeometry. */
export interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
}

const emptyMesh = (): MeshData => ({ positions: [], normals: [], indices: [] });

type P3 = readonly [number, number, number];

/** Add a quad p0..p3 (in order around its edge) facing `n`, fixing the winding if needed. */
function quad(m: MeshData, p: readonly [P3, P3, P3, P3], n: P3) {
  const base = m.positions.length / 3;
  for (const v of p) {
    m.positions.push(v[0], v[1], v[2]);
    m.normals.push(n[0], n[1], n[2]);
  }
  const [a, b, c] = p;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
  const ccw = cross[0]! * n[0] + cross[1]! * n[1] + cross[2]! * n[2] > 0;
  if (ccw) m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  else m.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/** One merged mesh for many boxes (one draw call for all walls of a floor). */
export function boxesMesh(boxes: readonly Box[]): MeshData {
  const m = emptyMesh();
  for (const b of boxes) {
    const [x0, x1] = [b.x - b.sx / 2, b.x + b.sx / 2];
    const [y0, y1] = [b.y - b.sy / 2, b.y + b.sy / 2];
    const [z0, z1] = [b.z - b.sz / 2, b.z + b.sz / 2];
    quad(
      m,
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      [1, 0, 0],
    );
    quad(
      m,
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      [-1, 0, 0],
    );
    quad(
      m,
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      [0, 1, 0],
    );
    quad(
      m,
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      [0, -1, 0],
    );
    quad(
      m,
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [0, 0, 1],
    );
    quad(
      m,
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
      [0, 0, -1],
    );
  }
  return m;
}

/**
 * One flat mesh for a room's tiles (DESIGN §7.4: one merged mesh per room per floor). Tiles in
 * a row are joined into one quad, so a rectangular room is a handful of triangles.
 */
export function tilesMesh(tiles: readonly Cell[], tileSize: number, y = 0): MeshData {
  const m = emptyMesh();
  const rows = new Map<number, number[]>();
  for (const c of tiles) {
    const row = rows.get(c.y);
    if (row) row.push(c.x);
    else rows.set(c.y, [c.x]);
  }
  for (const [ty, xs] of rows) {
    xs.sort((a, b) => a - b);
    let start = xs[0]!;
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === xs[i - 1]! + 1) continue;
      const end = xs[i - 1]! + 1;
      const [x0, x1, z0, z1] = [
        start * tileSize,
        end * tileSize,
        ty * tileSize,
        (ty + 1) * tileSize,
      ];
      quad(
        m,
        [
          [x0, y, z0],
          [x0, y, z1],
          [x1, y, z1],
          [x1, y, z0],
        ],
        [0, 1, 0],
      );
      if (i < xs.length) start = xs[i]!;
    }
  }
  return m;
}
