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
import { type CellMap, type Walls, doorSwingsIntoKeyedTile } from './plan';

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
  /** Home look (D41): what this half of a wall faces, a room id or OUTSIDE. */
  side?: string;
}

/** The `side` of a wall half that faces no room. */
export const OUTSIDE = '#outside';

/**
 * What each side of a wall edge faces, for walls split per side (D41): the room (or OUTSIDE)
 * on the low side (north of an east–west wall, west of a north–south one) and on the high side.
 * `u` is the tile index along the wall.
 */
export type WallSides = (line: number, horizontal: boolean, u: number) => [string, string];

/** WallSides from a floor's tiles. */
export const sidesFromCells =
  (cells: CellMap): WallSides =>
  (line, horizontal, u) => {
    const at = (x: number, y: number) => cells.get(cellKey(x, y)) ?? OUTSIDE;
    return horizontal ? [at(u, line - 1), at(u, line)] : [at(line - 1, u), at(line, u)];
  };

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
  /** Home look: split every wall into two halves along its line, one per side, per tile. */
  sides?: WallSides,
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
      // Two halves, each half as thick and shifted to its side, tagged with what it faces; cut
      // at tile edges, where the room on a side can change.
      const halves = (p: Piece): Box[] => {
        const res: Box[] = [];
        for (let s0 = p.a; s0 < p.b;) {
          const s1 = Math.min(p.b, Math.floor(s0) + 1);
          const [low, high] = sides!(line, horizontal, Math.floor(s0));
          const piece = {
            ...p,
            a: s0,
            b: s1,
            capA: p.capA && s0 === p.a,
            capB: p.capB && s1 === p.b,
          };
          for (const [side, sign] of [
            [low, -1],
            [high, 1],
          ] as const) {
            const box = toBox(piece, t / 2);
            const shift = (sign * t) / 4;
            res.push(
              horizontal ? { ...box, z: box.z + shift, side } : { ...box, x: box.x + shift, side },
            );
          }
          s0 = s1;
        }
        return res;
      };
      for (const p of pieces)
        if (p.y1 > p.y0) out.walls.push(...(sides ? halves(p) : [toBox(p, t)]));
      for (const p of glass) out.glass.push(toBox(p, t * 0.3));
    }
  }
  return out;
}

/**
 * Where a door or window model goes (D37). Its own frame: origin on the wall line at floor
 * level in the middle of the gap, local +x along the wall (towards larger x or y), local +z
 * across it. Turn by `rotationY` to get to the house: 0 for an `n` edge (local +z is south),
 * −90° for a `w` edge (local +x is south, local +z is west).
 */
export interface OpeningPlacement {
  /** `x,y,side`: unique per floor. */
  key: string;
  kind: 'door' | 'window';
  /** On an exterior wall (front door model, thicker wall). */
  exterior: boolean;
  /** Centre of the gap on the wall line. */
  x: number;
  z: number;
  rotationY: number;
  /** Gap length along the wall and the wall's thickness. */
  width: number;
  thickness: number;
  /** Height range the model fills: the whole door, or the window between sill and head. */
  y0: number;
  y1: number;
  /** Doors: which way across the wall the leaf opens (local z), as in the 2D plan. */
  swing: 1 | -1;
}

/**
 * The opening models of one floor, for the openings that are on a wall (the gaps `wallGeometry`
 * cuts). A door is always full height (a cut-away view clips it to the wall); a window fills the
 * pane `wallGeometry` leaves, which a low wall shrinks to its upper half.
 */
export function openingPlacements(
  w: Walls,
  openings: readonly OpeningLike[],
  cells: CellMap,
  tileSize: number,
  height: number,
): OpeningPlacement[] {
  const onWall = (o: OpeningLike, segs: Segment[]) =>
    segs.some((s) => {
      const horizontal = s.y1 === s.y2;
      const lo = Math.min(horizontal ? s.x1 : s.y1, horizontal ? s.x2 : s.y2);
      const hi = Math.max(horizontal ? s.x1 : s.y1, horizontal ? s.x2 : s.y2);
      return horizontal
        ? o.side === 'n' && o.y === s.y1 && o.x >= lo && o.x < hi
        : o.side === 'w' && o.x === s.x1 && o.y >= lo && o.y < hi;
    });
  const out: OpeningPlacement[] = [];
  for (const o of openings) {
    if (o.kind !== 'door' && o.kind !== 'window') continue;
    const exterior = onWall(o, w.exterior);
    if (!exterior && !onWall(o, w.interior)) continue;
    const n = o.side === 'n';
    const sill = height > WINDOW_SILL ? WINDOW_SILL : height / 2;
    const into = doorSwingsIntoKeyedTile(o, cells) ? 1 : -1;
    out.push({
      key: `${o.x},${o.y},${o.side}`,
      kind: o.kind,
      exterior,
      x: (n ? o.x + 0.5 : o.x) * tileSize,
      z: (n ? o.y : o.y + 0.5) * tileSize,
      rotationY: n ? 0 : -Math.PI / 2,
      width: (1 - 2 * OPENING_INSET) * tileSize,
      thickness: wallThickness(exterior ? 'exterior' : 'interior', tileSize),
      y0: o.kind === 'door' ? 0 : sill,
      y1: o.kind === 'door' ? DOOR_HEAD : Math.min(height, WINDOW_HEAD),
      // The keyed tile is south of an `n` edge (local +z) and east of a `w` edge (local −z).
      swing: n ? into : (-into as 1 | -1),
    });
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
  /**
   * Texture coordinates in metres, projected on the face's plane (D42): floors use (x, z), walls
   * (their run, height). A texture repeats every `size` metres by scaling these.
   */
  uvs?: number[];
}

const emptyMesh = (): MeshData => ({ positions: [], normals: [], indices: [], uvs: [] });

/** World-space planar UV of a vertex on a face with normal `n` (axis-aligned faces only). */
const planarUv = (v: P3, n: P3): [number, number] =>
  n[1] !== 0 ? [v[0], v[2]] : n[0] !== 0 ? [v[2], v[1]] : [v[0], v[1]];

type P3 = readonly [number, number, number];

/** Add a quad p0..p3 (in order around its edge) facing `n`, fixing the winding if needed. */
function quad(m: MeshData, p: readonly [P3, P3, P3, P3], n: P3) {
  const base = m.positions.length / 3;
  for (const v of p) {
    m.positions.push(v[0], v[1], v[2]);
    m.normals.push(n[0], n[1], n[2]);
    m.uvs?.push(...planarUv(v, n));
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
