/**
 * The layout (`house.json` v1) as plain data, and the pure grid operations the editor needs:
 * rectangles of tiles, occupancy (the footprint anchor rule and stacking), and resizing the grid
 * on any side (D17b). Structurally the same as the API's `House`; no imports from other layers.
 *
 * Conventions (data contract §2.2, `coords.ts`): +x east, +y south, origin north-west; a
 * placement's (x, y) is the minimum corner of its occupied rectangle after rotation; openings
 * sit on the `n` or `w` edge of a tile, so `x == width` (w) and `y == depth` (n) are valid.
 */
import { type Cell, type Rect, cellKey, occupiedRect, parseCellKey } from './coords';

export type LayoutRotation = 0 | 90 | 180 | 270;

export interface LayoutGrid {
  tileSize: number;
  width: number;
  depth: number;
}
export interface LayoutRoom {
  id: string;
  name: string;
  color: string;
}
export interface LayoutFloor {
  id: string;
  name: string;
  level: number;
  cells?: Record<string, string>;
}
export interface LayoutPlacement {
  itemId: string;
  floorId: string;
  x: number;
  y: number;
  rotation: LayoutRotation;
  footprint?: [number, number] | null;
}
export interface LayoutOpening {
  floorId: string;
  x: number;
  y: number;
  side: 'n' | 'w';
  kind: 'door' | 'window';
}
export interface Layout {
  $schema?: string | null;
  schemaVersion: 1;
  grid: LayoutGrid;
  rooms?: LayoutRoom[];
  floors: LayoutFloor[];
  placements?: LayoutPlacement[];
  openings?: LayoutOpening[];
}

/** Grid limits of the contract (`grid.width`, `grid.depth`: 1–512). */
export const MIN_GRID = 1;
export const MAX_GRID = 512;

/** Footprint `[w, d]` before rotation of an item without a placement override. */
export type FootprintOf = (itemId: string) => readonly [number, number];

/** The rectangle of tiles between two corners (inclusive), in any order. */
export function rectBetween(a: Cell, b: Cell): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

/** Every tile of a rectangle, row by row. */
export function rectCells(r: Rect): Cell[] {
  const out: Cell[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

export const insideGrid = (c: Cell, grid: { width: number; depth: number }): boolean =>
  Number.isInteger(c.x) &&
  Number.isInteger(c.y) &&
  c.x >= 0 &&
  c.y >= 0 &&
  c.x < grid.width &&
  c.y < grid.depth;

/** A cell clamped into the grid (for drags that leave it). */
export const clampToGrid = (c: Cell, grid: { width: number; depth: number }): Cell => ({
  x: Math.min(grid.width - 1, Math.max(0, c.x)),
  y: Math.min(grid.depth - 1, Math.max(0, c.y)),
});

export const rectInsideGrid = (r: Rect, grid: { width: number; depth: number }): boolean =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= grid.width && r.y + r.h <= grid.depth;

const rectHas = (r: Rect, c: Cell) =>
  c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h;

/** The tiles a placement occupies: its override, else the catalogue footprint. */
export function placementRect(p: LayoutPlacement, footprintOf: FootprintOf): Rect {
  const fp = p.footprint ?? footprintOf(p.itemId);
  return occupiedRect(p.x, p.y, p.rotation, [fp[0], fp[1]]);
}

/**
 * Items whose occupied rectangle covers `cell` on `floorId`, in layout order (stacking, DESIGN
 * 15.16: several items may share a tile; repeated clicks cycle through them).
 */
export function itemsAt(
  layout: Layout,
  floorId: string,
  cell: Cell,
  footprintOf: FootprintOf,
): string[] {
  return (layout.placements ?? [])
    .filter((p) => p.floorId === floorId && rectHas(placementRect(p, footprintOf), cell))
    .map((p) => p.itemId);
}

/** The next item of a stack after `current` (the first one if `current` isn't in it). */
export function cycleStack(stack: readonly string[], current: string | null): string | null {
  if (stack.length === 0) return null;
  const i = current === null ? -1 : stack.indexOf(current);
  return stack[(i + 1) % stack.length]!;
}

/**
 * Where a placement goes when it is rotated by 90° clockwise in place: same anchor (minimum
 * corner, the footprint anchor rule), shifted back inside the grid if the swapped rectangle
 * would stick out. Null if it can't fit at all.
 */
export function rotatedPlacement(
  p: LayoutPlacement,
  grid: { width: number; depth: number },
  footprintOf: FootprintOf,
): LayoutPlacement | null {
  const rotation = ((p.rotation + 90) % 360) as LayoutRotation;
  const next = { ...p, rotation };
  const r = placementRect(next, footprintOf);
  if (r.w > grid.width || r.h > grid.depth) return null;
  return {
    ...next,
    x: Math.min(Math.max(0, r.x), grid.width - r.w),
    y: Math.min(Math.max(0, r.y), grid.depth - r.h),
  };
}

/**
 * A placement moved by (dx, dy) tiles, kept inside the grid (a drag past the edge stops at it).
 * Null if the footprint is larger than the grid.
 */
export function movedPlacement(
  p: LayoutPlacement,
  dx: number,
  dy: number,
  grid: { width: number; depth: number },
  footprintOf: FootprintOf,
): LayoutPlacement | null {
  const r = placementRect(p, footprintOf);
  if (r.w > grid.width || r.h > grid.depth) return null;
  return {
    ...p,
    x: Math.min(Math.max(0, p.x + dx), grid.width - r.w),
    y: Math.min(Math.max(0, p.y + dy), grid.depth - r.h),
  };
}

// ---- resizing (D17b) ----------------------------------------------------------------------

/** Tiles added (positive) or removed (negative) on each side. */
export interface ResizeDeltas {
  n: number;
  e: number;
  s: number;
  w: number;
}

export interface LostCell {
  floorId: string;
  x: number;
  y: number;
  roomId: string;
}

/** What a resize cuts off, in the coordinates before the resize. */
export interface ResizeLoss {
  cells: LostCell[];
  placements: LayoutPlacement[];
  openings: LayoutOpening[];
}

export const resizedSize = (grid: { width: number; depth: number }, d: ResizeDeltas) => ({
  width: grid.width + d.w + d.e,
  depth: grid.depth + d.n + d.s,
});

export const sizeAllowed = (size: { width: number; depth: number }): boolean =>
  Number.isInteger(size.width) &&
  Number.isInteger(size.depth) &&
  size.width >= MIN_GRID &&
  size.width <= MAX_GRID &&
  size.depth >= MIN_GRID &&
  size.depth <= MAX_GRID;

const openingFits = (o: LayoutOpening, grid: { width: number; depth: number }) =>
  o.x >= 0 &&
  o.y >= 0 &&
  (o.side === 'n' ? o.x < grid.width && o.y <= grid.depth : o.x <= grid.width && o.y < grid.depth);

/**
 * Grow or shrink the grid. Growing north or west shifts every cell, placement and opening so
 * nothing moves relative to the house; shrinking drops what falls outside and reports it.
 * The caller checks `sizeAllowed` first.
 */
export function resizeLayout(
  layout: Layout,
  d: ResizeDeltas,
  footprintOf: FootprintOf,
): { layout: Layout; loss: ResizeLoss } {
  const size = resizedSize(layout.grid, d);
  const dx = d.w;
  const dy = d.n;
  const loss: ResizeLoss = { cells: [], placements: [], openings: [] };

  const floors = layout.floors.map((f) => {
    const cells: Record<string, string> = {};
    for (const [key, roomId] of Object.entries(f.cells ?? {})) {
      const c = parseCellKey(key);
      if (!c) continue;
      const moved = { x: c.x + dx, y: c.y + dy };
      if (insideGrid(moved, size)) cells[cellKey(moved.x, moved.y)] = roomId;
      else loss.cells.push({ floorId: f.id, x: c.x, y: c.y, roomId });
    }
    return { ...f, cells };
  });

  const placements: LayoutPlacement[] = [];
  for (const p of layout.placements ?? []) {
    const moved = { ...p, x: p.x + dx, y: p.y + dy };
    if (rectInsideGrid(placementRect(moved, footprintOf), size)) placements.push(moved);
    else loss.placements.push(p);
  }

  const openings: LayoutOpening[] = [];
  for (const o of layout.openings ?? []) {
    const moved = { ...o, x: o.x + dx, y: o.y + dy };
    if (openingFits(moved, size)) openings.push(moved);
    else loss.openings.push(o);
  }

  return {
    layout: { ...layout, grid: { ...layout.grid, ...size }, floors, placements, openings },
    loss,
  };
}

/** Stable keys of what a resize loses, so a confirmed loss can be compared on replay. */
export function lossKeys(loss: ResizeLoss): string[] {
  return [
    ...loss.cells.map((c) => `c:${c.floorId}:${c.x},${c.y}`),
    ...loss.placements.map((p) => `p:${p.itemId}`),
    ...loss.openings.map((o) => `o:${o.floorId}:${o.x},${o.y},${o.side}`),
  ];
}

export const lossIsEmpty = (loss: ResizeLoss): boolean =>
  loss.cells.length + loss.placements.length + loss.openings.length === 0;

export const openingKey = (o: Pick<LayoutOpening, 'floorId' | 'x' | 'y' | 'side'>): string =>
  `${o.floorId}:${o.x},${o.y},${o.side}`;

// ---- ids and names --------------------------------------------------------------------------

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `rm_` + 6 base36 characters, not used yet. `random` returns [0, 1). */
export function newRoomId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    let id = 'rm_';
    for (let i = 0; i < 6; i++) id += BASE36[Math.floor(random() * 36)];
    if (!taken.has(id)) return id;
  }
}

/** Room names the contract accepts: 1–100 characters after trimming. */
export const ROOM_NAME_MAX = 100;
export const cleanRoomName = (name: string): string | null => {
  const t = name.replace(/\s+/gu, ' ').trim();
  return t.length >= 1 && t.length <= ROOM_NAME_MAX ? t : null;
};

/** Ids the contract accepts for rooms, floors and items. */
export const isValidId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/u.test(id);

/** `#RRGGBB`, the only colour form the contract accepts. */
export const isRoomColor = (c: string): boolean => /^#[0-9A-Fa-f]{6}$/u.test(c);

// ---- comparing layouts (replay after another writer, M5-01/M5-02) ---------------------------

/** JSON with sorted keys and no null/undefined values: the same layout gives the same text
 *  whatever the key order (the server sorts cell keys and omits nulls when it writes). */
export function canonicalLayout(l: Layout): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k, x]) => x != null && k !== '$schema')
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    return v;
  };
  return JSON.stringify(norm(l));
}

/** Where things are: cells, placements and openings (not names or colours). */
function geometry(l: Layout): string {
  const floors = l.floors
    .map(
      (f) =>
        `${f.id}:${Object.entries(f.cells ?? {})
          .sort()
          .join(';')}`,
    )
    .sort();
  const placements = (l.placements ?? [])
    .map((p) => `${p.itemId}@${p.floorId}:${p.x},${p.y},${p.rotation}`)
    .sort();
  const openings = (l.openings ?? []).map((o) => `${openingKey(o)}:${o.kind}`).sort();
  return JSON.stringify([floors, placements, openings]);
}

/** How many tiles and placements of `prev`, moved by (dx, dy), are the same in `next`. */
function overlap(prev: Layout, next: Layout, dx: number, dy: number): number {
  const nextCells = new Map(next.floors.map((f) => [f.id, f.cells ?? {}]));
  let n = 0;
  for (const f of prev.floors) {
    const into = nextCells.get(f.id);
    if (!into) continue;
    for (const [k, room] of Object.entries(f.cells ?? {})) {
      const c = parseCellKey(k);
      if (c && into[cellKey(c.x + dx, c.y + dy)] === room) n++;
    }
  }
  const at = new Map((next.placements ?? []).map((p) => [p.itemId, p]));
  for (const p of prev.placements ?? []) {
    const q = at.get(p.itemId);
    if (q && q.floorId === p.floorId && q.x === p.x + dx && q.y === p.y + dy) n++;
  }
  return n;
}

/**
 * Same size, but the house may still have moved (West +1 / East −1 in one resize, or two
 * resizes, M5-07). Ordinary edits by another writer (a painted tile, a moved item) must not
 * count as a shift, so: no shift unless some shift explains more of `prev` than no shift does;
 * then that shift if it is the only one and exactly a resize, else unknown (null).
 */
function sameSizeShift(
  prev: Layout,
  next: Layout,
  footprintOf: FootprintOf,
): { dx: number; dy: number } | null {
  if (geometry(prev) === geometry(next)) return { dx: 0, dy: 0 };
  // Candidates: how each item that is in both layouts moved, and where a few tiles of the first
  // painted room went. A shift of the whole house shows up as one of these.
  const candidates = new Map<string, { dx: number; dy: number }>();
  const add = (dx: number, dy: number) => {
    if (dx || dy) candidates.set(`${dx},${dy}`, { dx, dy });
  };
  const at = new Map((next.placements ?? []).map((p) => [p.itemId, p]));
  for (const p of prev.placements ?? []) {
    const q = at.get(p.itemId);
    if (q && q.floorId === p.floorId) add(q.x - p.x, q.y - p.y);
  }
  const f0 = prev.floors.find((f) => Object.keys(f.cells ?? {}).length);
  if (f0) {
    const [k, room] = Object.entries(f0.cells!)[0]!;
    const c = parseCellKey(k)!;
    const into = next.floors.find((f) => f.id === f0.id)?.cells ?? {};
    let n = 0;
    for (const [k2, r2] of Object.entries(into)) {
      if (r2 !== room || n++ > 200) continue;
      const c2 = parseCellKey(k2);
      if (c2) add(c2.x - c.x, c2.y - c.y);
    }
  }
  const still = overlap(prev, next, 0, 0);
  let best: { dx: number; dy: number; score: number }[] = [];
  for (const { dx, dy } of candidates.values()) {
    const score = overlap(prev, next, dx, dy);
    if (score <= still) continue;
    if (!best.length || score > best[0]!.score) best = [{ dx, dy, score }];
    else if (score === best[0]!.score) best.push({ dx, dy, score });
  }
  if (!best.length) return { dx: 0, dy: 0 };
  if (best.length > 1) return null;
  const { dx, dy } = best[0]!;
  const moved = resizeLayout(prev, { w: dx, e: -dx, n: dy, s: -dy }, footprintOf).layout;
  return geometry(moved) === geometry(next) ? { dx, dy } : null;
}

/**
 * How another writer moved the grid's origin between two layouts, if the change was exactly a
 * resize (`resizeLayout` of `prev` gives `next`'s cells, placements and openings) and only one
 * shift explains it; with the same size, see `sameSizeShift`. Null when it can't be told
 * (ambiguous, or the geometry changed beyond a resize): commands made on `prev` can't be
 * translated then.
 */
export function inferShift(
  prev: Layout,
  next: Layout,
  footprintOf: FootprintOf,
): { dx: number; dy: number } | null {
  const dw = next.grid.width - prev.grid.width;
  const dd = next.grid.depth - prev.grid.depth;
  // Items move on their own all the time, so a shift is only ever inferred when painted tiles or
  // doors/windows confirm it (M5-11). Without them, the same size means no shift, and a new
  // size can't tell east from west (or north from south): unknown.
  const anchored =
    prev.floors.some((f) => Object.keys(f.cells ?? {}).length > 0) ||
    (prev.openings ?? []).length > 0;
  if (!anchored) return dw === 0 && dd === 0 ? { dx: 0, dy: 0 } : null;
  if (dw === 0 && dd === 0) return sameSizeShift(prev, next, footprintOf);
  const target = geometry(next);
  // A cheap first check per candidate: one painted tile of `prev` must land on the same room.
  const probe = prev.floors.flatMap((f) =>
    Object.entries(f.cells ?? {})
      .slice(0, 1)
      .map(([k, room]) => ({ f: f.id, c: parseCellKey(k)!, room })),
  )[0];
  const nextFloors = new Map(next.floors.map((f) => [f.id, f.cells ?? {}]));
  let found: { dx: number; dy: number } | null = null;
  for (let dx = Math.min(0, dw); dx <= Math.max(0, dw); dx++)
    for (let dy = Math.min(0, dd); dy <= Math.max(0, dd); dy++) {
      if (probe) {
        const moved = { x: probe.c.x + dx, y: probe.c.y + dy };
        const inside = insideGrid(moved, next.grid);
        if (inside && nextFloors.get(probe.f)?.[cellKey(moved.x, moved.y)] !== probe.room) continue;
      }
      const by = { w: dx, e: dw - dx, n: dy, s: dd - dy };
      if (geometry(resizeLayout(prev, by, footprintOf).layout) !== target) continue;
      if (found) return null;
      found = { dx, dy };
    }
  return found;
}

// ---- repairable problems (D30) ----------------------------------------------------------------

export interface IssueCell {
  floorId: string;
  x: number;
  y: number;
}

/**
 * Problems in a layout that the editor can repair (D30), each with what its fix needs. Duplicate
 * room/floor ids aren't here (which one is meant is a judgement), nor malformed cell keys (the
 * server normalises them when it reads the file).
 */
export type LayoutIssue =
  /** Tiles pointing to a room that doesn't exist: recreate the room, or erase the tiles. */
  | { kind: 'unknown_room'; roomId: string; cells: IssueCell[] }
  /** An item placed more than once: keep the first placement (the one shown). */
  | { kind: 'duplicate_placement'; itemId: string; count: number }
  /**
   * Tiles, placements or openings outside the grid: grow the grid to `fit` (east/south, null
   * when that would exceed the limit), or remove what's outside.
   */
  | {
      kind: 'outside_grid';
      fit: { width: number; depth: number } | null;
      cells: (IssueCell & { roomId: string })[];
      itemIds: string[];
      /** The placements outside, exactly (an item may also have a good copy, M5-09). */
      placements: LayoutPlacement[];
      openings: LayoutOpening[];
    }
  /** Placements or openings on a floor that doesn't exist: item to the tray, opening removed. */
  | {
      kind: 'unknown_floor';
      itemIds: string[];
      placements: LayoutPlacement[];
      openings: LayoutOpening[];
    };

export function layoutIssues(l: Layout, footprintOf: FootprintOf): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const rooms = new Set((l.rooms ?? []).map((r) => r.id));
  const floors = new Set(l.floors.map((f) => f.id));
  const { width, depth } = l.grid;
  let needW = width;
  let needD = depth;

  const unknown = new Map<string, IssueCell[]>();
  const outsideCells: (IssueCell & { roomId: string })[] = [];
  for (const f of l.floors)
    for (const [key, roomId] of Object.entries(f.cells ?? {})) {
      const c = parseCellKey(key);
      if (!c) continue;
      if (!rooms.has(roomId)) {
        const list = unknown.get(roomId) ?? [];
        list.push({ floorId: f.id, ...c });
        unknown.set(roomId, list);
      }
      if (!insideGrid(c, l.grid)) {
        outsideCells.push({ floorId: f.id, ...c, roomId });
        needW = Math.max(needW, c.x + 1);
        needD = Math.max(needD, c.y + 1);
      }
    }
  for (const [roomId, cells] of unknown) out.push({ kind: 'unknown_room', roomId, cells });

  const counts = new Map<string, number>();
  for (const p of l.placements ?? []) counts.set(p.itemId, (counts.get(p.itemId) ?? 0) + 1);
  for (const [itemId, count] of counts)
    if (count > 1) out.push({ kind: 'duplicate_placement', itemId, count });

  const outsideItems: string[] = [];
  const floorItems: string[] = [];
  const outsidePlacements: LayoutPlacement[] = [];
  const floorPlacements: LayoutPlacement[] = [];
  for (const p of l.placements ?? []) {
    if (!floors.has(p.floorId)) {
      if (!floorItems.includes(p.itemId)) floorItems.push(p.itemId);
      floorPlacements.push(p);
      continue;
    }
    const r = placementRect(p, footprintOf);
    if (!rectInsideGrid(r, l.grid)) {
      if (!outsideItems.includes(p.itemId)) outsideItems.push(p.itemId);
      outsidePlacements.push(p);
      needW = Math.max(needW, r.x + r.w);
      needD = Math.max(needD, r.y + r.h);
    }
  }

  const outsideOpenings: LayoutOpening[] = [];
  const floorOpenings: LayoutOpening[] = [];
  for (const o of l.openings ?? []) {
    if (!floors.has(o.floorId)) floorOpenings.push(o);
    else if (!openingFits(o, l.grid)) {
      outsideOpenings.push(o);
      needW = Math.max(needW, o.side === 'n' ? o.x + 1 : o.x);
      needD = Math.max(needD, o.side === 'n' ? o.y : o.y + 1);
    }
  }

  if (outsideCells.length || outsideItems.length || outsideOpenings.length) {
    const fit = { width: needW, depth: needD };
    out.push({
      kind: 'outside_grid',
      fit: sizeAllowed(fit) ? fit : null,
      cells: outsideCells,
      itemIds: outsideItems,
      placements: outsidePlacements,
      openings: outsideOpenings,
    });
  }
  if (floorItems.length || floorOpenings.length)
    out.push({
      kind: 'unknown_floor',
      itemIds: floorItems,
      placements: floorPlacements,
      openings: floorOpenings,
    });
  return out;
}

/**
 * How much of each problem a layout has, per subject, as the server counts them for D30
 * (`PUT` refuses a layout with more of any than the file on disk). Keys: `room:<floor>:<room>`
 * (tiles of a missing room), `dup:<item>`, `out:<floor>` (tiles and openings outside the grid),
 * `out-item:<item>`, `floor:<floor>` (openings on a missing floor), `floor-item:<item>`.
 */
export function problemCounts(l: Layout, footprintOf: FootprintOf): Map<string, number> {
  const n = new Map<string, number>();
  const add = (k: string, by = 1) => n.set(k, (n.get(k) ?? 0) + by);
  for (const issue of layoutIssues(l, footprintOf)) {
    switch (issue.kind) {
      case 'unknown_room':
        for (const c of issue.cells) add(`room:${c.floorId}:${issue.roomId}`);
        break;
      case 'duplicate_placement':
        add(`dup:${issue.itemId}`, issue.count - 1);
        break;
      case 'outside_grid':
        for (const c of issue.cells) add(`out:${c.floorId}`);
        for (const o of issue.openings) add(`out:${o.floorId}`);
        for (const id of issue.itemIds) add(`out-item:${id}`);
        break;
      case 'unknown_floor':
        for (const o of issue.openings) add(`floor:${o.floorId}`);
        for (const id of issue.itemIds) add(`floor-item:${id}`);
        break;
    }
  }
  return n;
}

/** True when `next` has more of some problem than `disk` (the server would refuse it, D30). */
export function addsProblems(next: Layout, disk: Layout, footprintOf: FootprintOf): boolean {
  const before = problemCounts(disk, footprintOf);
  for (const [k, v] of problemCounts(next, footprintOf)) if (v > (before.get(k) ?? 0)) return true;
  return false;
}
