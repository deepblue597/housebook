import fixtures from '@contract/fixtures/placement_cases.json';
import houseRaw from '../../../../examples/house/house.json?raw';
import { describe, expect, it } from 'vitest';
import { backEdge, cellKey, facing, occupiedRect, tileCenterWorld } from './coords';
import { type Walls, floorCells, walls } from './plan';
import {
  type Box,
  CEILING_HEIGHT,
  CUT_HEIGHT,
  DOOR_HEAD,
  OPENING_INSET,
  WALL_GAP,
  WALL_ITEM_TOP,
  WINDOW_HEAD,
  WINDOW_SILL,
  boxesAbove,
  boxesMesh,
  cellBounds,
  facingWalls,
  itemTransform,
  mountCentreY,
  roomAtPoint,
  tilesMesh,
  wallGeometry,
  wallThickness,
  worldToCell,
} from './scene';

const deg = (rad: number) => Math.round((rad * 180) / Math.PI);

describe('placement → 3D transform (contract/fixtures/placement_cases.json)', () => {
  for (const c of fixtures.cases) {
    const fp = c.footprint as [number, number];
    const { x, y, rotation } = c.placement;
    it(c.name, () => {
      expect(occupiedRect(x, y, rotation, fp)).toEqual(c.expect.occupied);
      expect(facing(rotation)).toBe(c.expect.faces);
      expect(backEdge(rotation)).toBe(c.expect.backEdge);

      const floor = itemTransform(
        c.placement,
        { footprint: fp, mount: 'floor' },
        { height: 1 },
        c.tileSize,
      );
      expect(floor.position.x).toBeCloseTo(c.expect.centre.x, 9);
      expect(floor.position.z).toBeCloseTo(c.expect.centre.z, 9);
      expect(deg(floor.rotationY)).toBe(c.expect.threeRotationYDeg);
      expect(floor.rect).toEqual(c.expect.occupied);

      // A wall item hangs towards the edge its back is against.
      const wall = itemTransform(
        c.placement,
        { footprint: fp, mount: 'wall' },
        { height: 0.5, depth: 0.2 },
        c.tileSize,
      );
      const dx = wall.position.x - floor.position.x;
      const dz = wall.position.z - floor.position.z;
      const shift = (fp[1] * c.tileSize) / 2 - WALL_GAP - wall.size.z / 2;
      expect(dx).toBeCloseTo(c.expect.backDirection.x * shift, 9);
      expect(dz).toBeCloseTo(c.expect.backDirection.z * shift, 9);
    });
  }

  it('a 1×1 floor item sits on the tile centre from coords.tileCenterWorld', () => {
    const t = itemTransform(
      { x: 5, y: 7, rotation: 0 },
      { footprint: [1, 1], mount: 'floor' },
      { height: 0.8 },
      0.5,
    );
    const c = tileCenterWorld({ x: 5, y: 7 }, 0.5);
    expect([t.position.x, t.position.z]).toEqual([c.x, c.z]);
    expect(t.position.y).toBeCloseTo(0.4);
  });

  it('three rotation.y turns the model front (+z) to the compass direction it faces', () => {
    // three's rotation about y maps local +z to (sin θ, cos θ) in world (x, z).
    const toWorld = { south: [0, 1], west: [-1, 0], north: [0, -1], east: [1, 0] } as const;
    for (const r of [0, 90, 180, 270]) {
      const t = itemTransform(
        { x: 0, y: 0, rotation: r },
        { footprint: [1, 1], mount: 'floor' },
        { height: 1 },
        1,
      );
      const [fx, fz] = toWorld[facing(r)];
      expect(Math.sin(t.rotationY)).toBeCloseTo(fx, 9);
      expect(Math.cos(t.rotationY)).toBeCloseTo(fz, 9);
    }
  });

  it('wall items hang with their top at ~1.8 m (DESIGN §7.4)', () => {
    expect(mountCentreY('floor', 0.8)).toBe(0.4);
    expect(mountCentreY('wall', 0.4) + 0.2).toBeCloseTo(WALL_ITEM_TOP, 9);
    expect(WALL_ITEM_TOP).toBeCloseTo(1.8, 9);
    // Never below the floor, even for a very tall item.
    expect(mountCentreY('wall', 4)).toBe(2);
  });

  it('ceiling items hang from the ceiling', () => {
    expect(mountCentreY('ceiling', 0.06)).toBeCloseTo(CEILING_HEIGHT - 0.03);
  });

  it('model size follows the footprint (and the per-type depth for wall items)', () => {
    const t = itemTransform(
      { x: 0, y: 0, rotation: 90 },
      { footprint: [2, 1], mount: 'floor' },
      { height: 1, fill: 1 },
      0.5,
    );
    expect(t.size).toEqual({ x: 1, y: 1, z: 0.5 }); // own frame: w along x before rotation
    expect(t.footprint).toEqual({ x: 1, z: 0.5 });
    const w = itemTransform(
      { x: 0, y: 0, rotation: 0 },
      { footprint: [1, 1], mount: 'wall' },
      { height: 1, depth: 0.1 },
      1,
    );
    expect(w.size.z).toBe(0.1);
  });
});

describe('picking', () => {
  const cells = floorCells({ '0,0': 'a', '1,0': 'b' }, { width: 4, depth: 3 }, new Set(['a', 'b']));
  it('maps a floor point to its tile and room', () => {
    expect(worldToCell(0.99, 0.01, 1)).toEqual({ x: 0, y: 0 });
    expect(worldToCell(1, 0.5, 1)).toEqual({ x: 1, y: 0 });
    expect(worldToCell(0.6, 1.1, 0.5)).toEqual({ x: 1, y: 2 });
    expect(worldToCell(-0.1, 0, 1)).toEqual({ x: -1, y: 0 });
    expect(roomAtPoint(cells, 1.5, 0.5, 1)).toBe('b');
    expect(roomAtPoint(cells, 2.5, 0.5, 1)).toBeUndefined();
  });

  it('bounds cover the painted cells, or the grid when none are painted', () => {
    expect(cellBounds(cells, { width: 4, depth: 3 })).toEqual({ x0: 0, y0: 0, x1: 2, y1: 1 });
    expect(cellBounds(new Map(), { width: 4, depth: 3 })).toEqual({ x0: 0, y0: 0, x1: 4, y1: 3 });
  });
});

// A A B
// A A B
const twoRooms = floorCells(
  { '0,0': 'a', '1,0': 'a', '2,0': 'b', '0,1': 'a', '1,1': 'a', '2,1': 'b' },
  { width: 3, depth: 2 },
  new Set(['a', 'b']),
);

const volume = (boxes: Box[]) => boxes.reduce((s, b) => s + b.sx * b.sy * b.sz, 0);

describe('walls in 3D (same edges as the 2D plan)', () => {
  it('turns every wall edge into a box of the wall height, exterior thicker than interior', () => {
    const w = walls(twoRooms);
    const g = wallGeometry(w, [], 1, CUT_HEIGHT);
    expect(g.walls).toHaveLength(w.exterior.length + w.interior.length);
    expect(g.glass).toEqual([]);
    for (const b of g.walls) {
      expect(b.sy).toBe(CUT_HEIGHT);
      expect(b.y).toBe(CUT_HEIGHT / 2);
    }
    // The interior wall between a and b: x = 2, from z 0 to 2.
    const inner = g.walls.find((b) => b.x === 2 && b.sx === wallThickness('interior', 1));
    expect(inner!.z).toBeCloseTo(1, 9);
    expect(inner!.sz).toBeCloseTo(2 + wallThickness('interior', 1), 9);
    // Exterior walls are thicker.
    expect(g.walls.filter((b) => b.sx === 0.2 || b.sz === 0.2)).toHaveLength(w.exterior.length);
  });

  it('a door cuts a gap; with walls up a lintel stays above it', () => {
    const w = walls(twoRooms);
    const door = { x: 2, y: 0, side: 'w' as const, kind: 'door' };
    const cut = wallGeometry(w, [door], 1, CUT_HEIGHT);
    const plain = wallGeometry(w, [], 1, CUT_HEIGHT);
    expect(cut.walls).toHaveLength(plain.walls.length + 1); // split in two
    const gap = (1 - 2 * OPENING_INSET) * CUT_HEIGHT * wallThickness('interior', 1);
    expect(volume(plain.walls) - volume(cut.walls)).toBeCloseTo(gap, 9);

    const up = wallGeometry(w, [door], 1, CEILING_HEIGHT);
    const lintel = up.walls.find((b) => Math.abs(b.y - b.sy / 2 - DOOR_HEAD) < 1e-9);
    expect(lintel).toMatchObject({ x: 2, z: 0.5 });
    expect(lintel!.sz).toBeCloseTo(1 - 2 * OPENING_INSET, 9);
    expect(lintel!.sy).toBeCloseTo(CEILING_HEIGHT - DOOR_HEAD);
  });

  it('a window leaves a sill and a head with a pane between them', () => {
    const w = walls(twoRooms);
    const win = { x: 0, y: 0, side: 'n' as const, kind: 'window' };
    const up = wallGeometry(w, [win], 1, CEILING_HEIGHT);
    const at = (b: Box) => b.z === 0 && Math.abs(b.sx - (1 - 2 * OPENING_INSET)) < 1e-9;
    const round = (v: number) => Number(v.toFixed(6));
    const pieces = up.walls.filter(at).map((b) => [round(b.y - b.sy / 2), round(b.y + b.sy / 2)]);
    expect(pieces).toEqual([
      [0, WINDOW_SILL],
      [WINDOW_HEAD, CEILING_HEIGHT],
    ]);
    expect(up.glass).toHaveLength(1);
    expect(up.glass[0]!.sy).toBeCloseTo(WINDOW_HEAD - WINDOW_SILL);
    // Cut-away below the sill: the window still shows, as a dip with the pane in it.
    const cut = wallGeometry(w, [win], 1, CUT_HEIGHT);
    expect(CUT_HEIGHT).toBeLessThan(WINDOW_SILL);
    const sill = cut.walls.filter(at);
    expect(sill).toHaveLength(1);
    expect(sill[0]!.sy).toBeCloseTo(CUT_HEIGHT / 2);
    expect(cut.glass).toHaveLength(1);
    expect(cut.glass[0]!.y - cut.glass[0]!.sy / 2).toBeCloseTo(CUT_HEIGHT / 2);
    expect(cut.glass[0]!.y + cut.glass[0]!.sy / 2).toBeCloseTo(CUT_HEIGHT);
  });

  it('openings on edges without a wall are ignored', () => {
    const w = walls(twoRooms);
    const inside = { x: 1, y: 0, side: 'w' as const, kind: 'door' }; // between two tiles of room a
    expect(wallGeometry(w, [inside], 1, 1)).toEqual(wallGeometry(w, [], 1, 1));
  });

  it('example house: one wall box per wall edge plus one per door/window split', () => {
    const house = JSON.parse(houseRaw) as {
      grid: { width: number; depth: number; tileSize: number };
      rooms: { id: string }[];
      floors: { id: string; cells: Record<string, string> }[];
      openings: { floorId: string; x: number; y: number; side: 'n' | 'w'; kind: string }[];
    };
    const floor = house.floors[0]!;
    const cells = floorCells(floor.cells, house.grid, new Set(house.rooms.map((r) => r.id)));
    const w = walls(cells);
    const openings = house.openings.filter((o) => o.floorId === floor.id);
    const g = wallGeometry(w, openings, house.grid.tileSize, CUT_HEIGHT);
    const doors = openings.filter((o) => o.kind === 'door').length;
    const windows = openings.filter((o) => o.kind === 'window').length;
    // Each opening on a wall splits it (+1 box); a window also keeps its sill (+1 more).
    expect(g.walls.length).toBe(w.exterior.length + w.interior.length + doors + 2 * windows);
    expect(g.glass).toHaveLength(windows);
    // Nothing pokes outside the grid by more than half a wall.
    for (const b of g.walls) {
      expect(b.x - b.sx / 2).toBeGreaterThanOrEqual(-0.1);
      expect(b.z + b.sz / 2).toBeLessThanOrEqual(house.grid.depth + 0.1);
    }
    expect(cells.get(cellKey(1, 1))).toBe('rm_liv');
  });
});

describe('mesh buffers', () => {
  const normalOf = (m: ReturnType<typeof boxesMesh>, tri: number) => {
    const p = (i: number) => m.positions.slice(m.indices[i]! * 3, m.indices[i]! * 3 + 3);
    const [a, b, c] = [p(tri * 3), p(tri * 3 + 1), p(tri * 3 + 2)];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    return [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
  };

  it('merges boxes into one indexed mesh with outward faces', () => {
    const m = boxesMesh([
      { x: 0, y: 0.5, z: 0, sx: 1, sy: 1, sz: 0.2 },
      { x: 3, y: 0.5, z: 0, sx: 0.2, sy: 1, sz: 2 },
    ]);
    expect(m.positions).toHaveLength(2 * 24 * 3);
    expect(m.indices).toHaveLength(2 * 36);
    // Every triangle winds counter-clockwise around its stored normal (front face outwards).
    for (let t = 0; t < m.indices.length / 3; t++) {
      const n = normalOf(m, t);
      const vi = m.indices[t * 3]! * 3;
      const stored = m.normals.slice(vi, vi + 3);
      expect(n[0]! * stored[0]! + n[1]! * stored[1]! + n[2]! * stored[2]!).toBeGreaterThan(0);
    }
  });

  it('joins a room row into one quad facing up', () => {
    const tiles = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
    ];
    const m = tilesMesh(tiles, 0.5);
    expect(m.indices).toHaveLength(3 * 6); // row 0 joined, row 1 has two runs
    for (let t = 0; t < m.indices.length / 3; t++) expect(normalOf(m, t)[1]).toBeGreaterThan(0);
    // Covered area matches the tiles.
    let area = 0;
    for (let t = 0; t < m.indices.length / 3; t++) area += normalOf(m, t)[1]! / 2;
    expect(area).toBeCloseTo(5 * 0.25);
  });
});

describe('walls facing the camera (faded with walls up, M2-03)', () => {
  //   x: 0 1 2
  // y=0  a a b
  // y=1  a a b
  // y=2  . c c
  const cells = floorCells(
    {
      '0,0': 'a',
      '1,0': 'a',
      '2,0': 'b',
      '0,1': 'a',
      '1,1': 'a',
      '2,1': 'b',
      '1,2': 'c',
      '2,2': 'c',
    },
    { width: 3, depth: 3 },
    new Set(['a', 'b', 'c']),
  );
  const w = walls(cells);
  const h = (y: number, x1: number, x2: number) => ({ x1, y1: y, x2, y2: y });
  const v = (x: number, y1: number, y2: number) => ({ x1: x, y1, x2: x, y2 });
  const len = (ws: Walls) =>
    [...ws.interior, ...ws.exterior].reduce((s, g) => s + Math.abs(g.x2 - g.x1 + g.y2 - g.y1), 0);

  it.each(['north', 'east', 'south', 'west'] as const)(
    'looking %s, facing + other is every wall, nothing lost or doubled',
    (heading) => {
      const { facing, other } = facingWalls(w, cells, heading);
      expect(len(facing) + len(other)).toBe(len(w));
    },
  );

  it('looking north: east–west walls with a room north of them face the camera', () => {
    const { facing, other } = facingWalls(w, cells, 'north');
    // The far (north) exterior wall hides nothing inside the house.
    expect(other.exterior).toContainEqual(h(0, 0, 3));
    // The near (south) exterior walls and every interior east–west wall hide rooms.
    expect(facing.exterior).toContainEqual(h(3, 1, 3));
    expect(facing.exterior).toContainEqual(h(2, 0, 1));
    expect(facing.interior).toContainEqual(h(2, 1, 3));
    // North–south walls run along the view: never faded.
    expect([...facing.interior, ...facing.exterior].every((s) => s.y1 === s.y2)).toBe(true);
  });

  it('looking south: the north exterior wall faces the camera, the south one does not', () => {
    const { facing, other } = facingWalls(w, cells, 'south');
    expect(facing.exterior).toContainEqual(h(0, 0, 3));
    expect(other.exterior).toContainEqual(h(3, 1, 3));
    // (0,2) is empty: the exterior edge below (0,1) hides nothing looking south.
    expect(other.exterior).toContainEqual(h(2, 0, 1));
    expect(facing.interior).toContainEqual(h(2, 1, 3));
  });

  it('looking east or west: north–south walls with a room beyond them face the camera', () => {
    const east = facingWalls(w, cells, 'east');
    expect(east.facing.interior).toContainEqual(v(2, 0, 2)); // a | b, b is beyond
    expect(east.other.exterior).toContainEqual(v(3, 0, 3)); // far east exterior
    expect(east.facing.exterior).toContainEqual(v(0, 0, 2)); // near west exterior
    expect([...east.facing.interior, ...east.facing.exterior].every((s) => s.x1 === s.x2)).toBe(
      true,
    );
    const west = facingWalls(w, cells, 'west');
    expect(west.facing.interior).toContainEqual(v(2, 0, 2)); // a is beyond, looking west
    expect(west.other.exterior).toContainEqual(v(0, 0, 2));
    expect(west.facing.exterior).toContainEqual(v(3, 0, 3));
  });

  it('a wall that hides a room along part of its length is split there', () => {
    // Two tiles touching at a corner: the exterior line y = 1 is one merged segment, with
    // (0,0) north of its west half and nothing north of its east half.
    const diag = floorCells({ '0,0': 'a', '1,1': 'a' }, { width: 2, depth: 2 }, new Set(['a']));
    const dw = walls(diag);
    expect(dw.exterior).toContainEqual(h(1, 0, 2));
    const { facing, other } = facingWalls(dw, diag, 'north');
    expect(facing.exterior).toContainEqual(h(1, 0, 1));
    expect(other.exterior).toContainEqual(h(1, 1, 2));
  });

  it('boxesAbove keeps what is above a height and drops what is below', () => {
    const b: Box = { x: 0, y: 1.25, z: 0, sx: 1, sy: 2.5, sz: 0.1 };
    expect(boxesAbove([b], CUT_HEIGHT)).toEqual([
      { ...b, y: (2.5 + CUT_HEIGHT) / 2, sy: 2.5 - CUT_HEIGHT },
    ]);
    expect(boxesAbove([{ ...b, y: 0.1, sy: 0.2 }], CUT_HEIGHT)).toEqual([]);
  });
});
