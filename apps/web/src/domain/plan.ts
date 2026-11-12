/**
 * Derived plan geometry: valid cells, walls, room areas and label positions. Walls and rooms
 * are never stored; they come from the floor's cells (DESIGN §4).
 */
import { type Cell, type Segment, cellKey, parseCellKey } from './coords';

/** cellKey -> roomId, restricted to cells inside the grid that point at a known room. */
export type CellMap = ReadonlyMap<string, string>;

export interface GridSize {
  width: number;
  depth: number;
}

export function floorCells(
  cells: Readonly<Record<string, string>> | undefined,
  grid: GridSize,
  knownRooms: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, roomId] of Object.entries(cells ?? {})) {
    const c = parseCellKey(key);
    if (c && c.x < grid.width && c.y < grid.depth && knownRooms.has(roomId)) out.set(key, roomId);
  }
  return out;
}

export interface Walls {
  /** Between two different rooms. */
  interior: Segment[];
  /** Between a room and an empty tile (or the grid edge); drawn thicker. */
  exterior: Segment[];
}

/**
 * Wall edges: an edge between a room tile and a different room or an empty tile is a wall.
 * Collinear neighbouring edges of the same kind are merged into one segment.
 */
export function walls(cells: CellMap): Walls {
  const interior: Segment[] = [];
  const exterior: Segment[] = [];
  const at = (x: number, y: number) => cells.get(cellKey(x, y));
  for (const [key, room] of cells) {
    const { x, y } = parseCellKey(key)!;
    const edges: [string | undefined, Segment, boolean][] = [
      // [neighbour, edge, owns the interior edge (each shared edge is emitted once)]
      [at(x + 1, y), { x1: x + 1, y1: y, x2: x + 1, y2: y + 1 }, true],
      [at(x, y + 1), { x1: x, y1: y + 1, x2: x + 1, y2: y + 1 }, true],
      [at(x - 1, y), { x1: x, y1: y, x2: x, y2: y + 1 }, false],
      [at(x, y - 1), { x1: x, y1: y, x2: x + 1, y2: y }, false],
    ];
    for (const [neighbour, edge, owns] of edges) {
      if (neighbour === undefined) exterior.push(edge);
      else if (neighbour !== room && owns) interior.push(edge);
    }
  }
  return { interior: mergeSegments(interior), exterior: mergeSegments(exterior) };
}

/** Join unit edges that touch end to end along the same line. */
export function mergeSegments(segments: readonly Segment[]): Segment[] {
  const horizontal = new Map<number, [number, number][]>();
  const vertical = new Map<number, [number, number][]>();
  for (const s of segments) {
    if (s.y1 === s.y2) push(horizontal, s.y1, [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)]);
    else push(vertical, s.x1, [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)]);
  }
  const out: Segment[] = [];
  for (const [y, runs] of sorted(horizontal))
    for (const [a, b] of joinRuns(runs)) out.push({ x1: a, y1: y, x2: b, y2: y });
  for (const [x, runs] of sorted(vertical))
    for (const [a, b] of joinRuns(runs)) out.push({ x1: x, y1: a, x2: x, y2: b });
  return out;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

const sorted = <V>(m: Map<number, V>) => [...m].sort((a, b) => a[0] - b[0]);

function joinRuns(runs: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...runs].sort((p, q) => p[0] - q[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Room id -> its tiles on this floor (in key order). */
export function roomTiles(cells: CellMap): Map<string, Cell[]> {
  const out = new Map<string, Cell[]>();
  for (const [key, room] of cells) push(out, room, parseCellKey(key)!);
  return out;
}

/** Area in m² of `tiles` tiles. */
export const area = (tiles: number, tileSize: number): number => tiles * tileSize * tileSize;

/** `16` -> `16 m²`, `2.25` -> `2.3 m²`. */
export const formatArea = (m2: number): string => `${Number.isInteger(m2) ? m2 : m2.toFixed(1)} m²`;

/**
 * Where to put a room's name: the centroid if it falls on the room and isn't covered by an
 * item, otherwise the free tile of the room closest to the centroid. Returns the label
 * centre in tile units.
 */
export function labelPosition(
  tiles: readonly Cell[],
  cells: CellMap,
  occupied: ReadonlySet<string>,
): { x: number; y: number } {
  if (tiles.length === 0) throw new RangeError('room without tiles');
  const room = cells.get(cellKey(tiles[0]!.x, tiles[0]!.y));
  const ax = tiles.reduce((s, c) => s + c.x, 0) / tiles.length;
  const ay = tiles.reduce((s, c) => s + c.y, 0) / tiles.length;
  const free = (x: number, y: number) =>
    cells.get(cellKey(x, y)) === room && !occupied.has(cellKey(x, y));
  // The label spans the centroid, which may sit on a tile corner or edge: check both tiles.
  if (free(Math.floor(ax + 0.5), Math.floor(ay + 0.5)) && free(Math.floor(ax), Math.floor(ay))) {
    return { x: ax + 0.5, y: ay + 0.5 };
  }
  const unoccupied = tiles.filter((c) => !occupied.has(cellKey(c.x, c.y)));
  const pool = unoccupied.length ? unoccupied : tiles;
  const dist = (c: Cell) => Math.hypot(c.x - ax, c.y - ay);
  const best = pool.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return { x: best.x + 0.5, y: best.y + 0.5 };
}

/**
 * Openings whose edge is a wall on this floor: tiles of two different rooms, or a room and no
 * room. A door or window whose wall went away (its rooms were repainted) stays in `house.json`
 * but isn't drawn, in 2D as in 3D (`openingPlacements`).
 */
export function openingsOnWalls<T extends { x: number; y: number; side: 'n' | 'w' }>(
  openings: readonly T[],
  cells: CellMap,
): T[] {
  return openings.filter((o) => {
    const a = cells.get(cellKey(o.x, o.y));
    const b = cells.get(o.side === 'n' ? cellKey(o.x, o.y - 1) : cellKey(o.x - 1, o.y));
    return (a !== undefined || b !== undefined) && a !== b;
  });
}

/** Which tile a door swings into: the keyed tile if it is part of a room, else the other one. */
export function doorSwingsIntoKeyedTile(
  o: { x: number; y: number; side: 'n' | 'w' },
  cells: CellMap,
): boolean {
  return (
    cells.has(cellKey(o.x, o.y)) ||
    !cells.has(o.side === 'n' ? cellKey(o.x, o.y - 1) : cellKey(o.x - 1, o.y))
  );
}
