import { describe, expect, it } from 'vitest';
import { house as exampleHouse } from '../test/exampleHouse';
import {
  isWallEdge,
  nearestEdge,
  firstLayout,
  type Layout,
  type LayoutPlacement,
  canonicalLayout,
  cleanRoomName,
  inferShift,
  clampToGrid,
  cycleStack,
  insideGrid,
  isRoomColor,
  itemsAt,
  lossIsEmpty,
  lossKeys,
  movedPlacement,
  newRoomId,
  placementRect,
  rectBetween,
  rectCells,
  resizeLayout,
  resizedSize,
  rotatedPlacement,
  sizeAllowed,
} from './layout';

const fp11 = () => [1, 1] as const;
const example: Layout = exampleHouse;

const small = (): Layout => ({
  schemaVersion: 2,
  grid: { tileSize: 1, width: 4, depth: 3 },
  rooms: [{ id: 'rm_a', name: 'A', color: '#112233' }],
  floors: [
    { id: 'fl', name: 'F', level: 0, cells: { '0,0': 'rm_a', '3,2': 'rm_a', '1,1': 'rm_a' } },
  ],
  placements: [
    { itemId: 'it_a', floorId: 'fl', x: 0, y: 0, rotation: 0 },
    { itemId: 'it_b', floorId: 'fl', x: 3, y: 2, rotation: 90 },
  ],
  openings: [
    { floorId: 'fl', x: 4, y: 0, side: 'w', kind: 'window' },
    { floorId: 'fl', x: 1, y: 3, side: 'n', kind: 'door' },
  ],
});

describe('rectangles', () => {
  it('spans two corners in any order, inclusive', () => {
    expect(rectBetween({ x: 3, y: 1 }, { x: 1, y: 2 })).toEqual({ x: 1, y: 1, w: 3, h: 2 });
    expect(rectBetween({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({ x: 2, y: 2, w: 1, h: 1 });
    expect(rectCells({ x: 1, y: 1, w: 2, h: 2 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ]);
  });

  it('knows the grid', () => {
    const g = { width: 4, depth: 3 };
    expect(insideGrid({ x: 3, y: 2 }, g)).toBe(true);
    expect(insideGrid({ x: 4, y: 0 }, g)).toBe(false);
    expect(insideGrid({ x: -1, y: 0 }, g)).toBe(false);
    expect(clampToGrid({ x: 9, y: -3 }, g)).toEqual({ x: 3, y: 0 });
  });
});

describe('occupancy and stacking (footprint anchor rule)', () => {
  it('anchor is the min corner after rotation; 90/270 swap w and d', () => {
    const p: LayoutPlacement = { itemId: 'sofa', floorId: 'fl', x: 2, y: 1, rotation: 90 };
    expect(placementRect(p, () => [3, 1])).toEqual({ x: 2, y: 1, w: 1, h: 3 });
    expect(placementRect({ ...p, footprint: [2, 2] }, () => [3, 1])).toEqual({
      x: 2,
      y: 1,
      w: 2,
      h: 2,
    });
  });

  it('finds every item covering a tile, in layout order', () => {
    const l: Layout = {
      ...small(),
      placements: [
        { itemId: 'sofa', floorId: 'fl', x: 0, y: 0, rotation: 0 },
        { itemId: 'lamp', floorId: 'fl', x: 1, y: 0, rotation: 0 },
        { itemId: 'other', floorId: 'fl2', x: 1, y: 0, rotation: 0 },
      ],
    };
    const fp = (id: string) => (id === 'sofa' ? ([2, 1] as const) : ([1, 1] as const));
    expect(itemsAt(l, 'fl', { x: 1, y: 0 }, fp)).toEqual(['sofa', 'lamp']);
    expect(itemsAt(l, 'fl', { x: 0, y: 0 }, fp)).toEqual(['sofa']);
    expect(itemsAt(l, 'fl', { x: 2, y: 0 }, fp)).toEqual([]);
  });

  it('cycles a stack', () => {
    expect(cycleStack(['a', 'b', 'c'], null)).toBe('a');
    expect(cycleStack(['a', 'b', 'c'], 'a')).toBe('b');
    expect(cycleStack(['a', 'b', 'c'], 'c')).toBe('a');
    expect(cycleStack(['a', 'b'], 'zz')).toBe('a');
    expect(cycleStack([], 'a')).toBeNull();
  });

  it('rotates in place, shifting back inside the grid when needed', () => {
    const g = { width: 4, depth: 3 };
    const p: LayoutPlacement = { itemId: 'sofa', floorId: 'fl', x: 1, y: 2, rotation: 0 };
    // 3×1 at the bottom row turns into 1×3: it can't hang below the grid, so it moves up.
    expect(rotatedPlacement(p, g, () => [3, 1])).toMatchObject({ rotation: 90, x: 1, y: 0 });
    expect(rotatedPlacement({ ...p, rotation: 270 }, g, fp11)).toMatchObject({ rotation: 0 });
    expect(rotatedPlacement(p, { width: 4, depth: 2 }, () => [3, 1])).toBeNull();
  });

  it('moves, clamped to the grid', () => {
    const g = { width: 4, depth: 3 };
    const p: LayoutPlacement = { itemId: 'a', floorId: 'fl', x: 1, y: 1, rotation: 0 };
    expect(movedPlacement(p, 1, 1, g, fp11)).toMatchObject({ x: 2, y: 2 });
    expect(movedPlacement(p, 10, -10, g, fp11)).toMatchObject({ x: 3, y: 0 });
    expect(movedPlacement(p, 10, 0, g, () => [2, 1])).toMatchObject({ x: 2 });
    expect(movedPlacement(p, 0, 0, g, () => [5, 1])).toBeNull();
  });
});

describe('resizing (D17b)', () => {
  it('computes the new size and its limits', () => {
    expect(resizedSize({ width: 16, depth: 10 }, { n: 1, e: -2, s: 0, w: 3 })).toEqual({
      width: 17,
      depth: 11,
    });
    expect(sizeAllowed({ width: 1, depth: 512 })).toBe(true);
    expect(sizeAllowed({ width: 0, depth: 5 })).toBe(false);
    expect(sizeAllowed({ width: 513, depth: 5 })).toBe(false);
  });

  it('growing north and west shifts cells, placements and openings; nothing is lost', () => {
    const { layout, loss } = resizeLayout(small(), { n: 2, e: 0, s: 0, w: 1 }, fp11);
    expect(lossIsEmpty(loss)).toBe(true);
    expect(layout.grid).toMatchObject({ width: 5, depth: 5, tileSize: 1 });
    expect(layout.floors[0]!.cells).toEqual({ '1,2': 'rm_a', '4,4': 'rm_a', '2,3': 'rm_a' });
    expect(layout.placements).toEqual([
      { itemId: 'it_a', floorId: 'fl', x: 1, y: 2, rotation: 0 },
      { itemId: 'it_b', floorId: 'fl', x: 4, y: 4, rotation: 90 },
    ]);
    // The east boundary window (x == width) and the south boundary door (y == depth) stay
    // on the boundary.
    expect(layout.openings).toEqual([
      { floorId: 'fl', x: 5, y: 2, side: 'w', kind: 'window' },
      { floorId: 'fl', x: 2, y: 5, side: 'n', kind: 'door' },
    ]);
  });

  it('growing south and east shifts nothing', () => {
    const before = small();
    const { layout } = resizeLayout(before, { n: 0, e: 3, s: 1, w: 0 }, fp11);
    expect(layout.floors[0]!.cells).toEqual(before.floors[0]!.cells);
    expect(layout.placements).toEqual(before.placements);
    expect(layout.grid).toMatchObject({ width: 7, depth: 4 });
  });

  it('shrinking reports what it cuts, in the old coordinates', () => {
    const { layout, loss } = resizeLayout(small(), { n: -1, e: -1, s: 0, w: 0 }, fp11);
    expect(layout.grid).toMatchObject({ width: 3, depth: 2 });
    expect(loss.cells).toEqual([
      { floorId: 'fl', x: 0, y: 0, roomId: 'rm_a' },
      { floorId: 'fl', x: 3, y: 2, roomId: 'rm_a' },
    ]);
    expect(loss.placements.map((p) => p.itemId)).toEqual(['it_a', 'it_b']);
    // The window was on the cut-off row.
    expect(loss.openings).toEqual([{ floorId: 'fl', x: 4, y: 0, side: 'w', kind: 'window' }]);
    expect(layout.floors[0]!.cells).toEqual({ '1,0': 'rm_a' });
    expect(layout.openings).toEqual([{ floorId: 'fl', x: 1, y: 2, side: 'n', kind: 'door' }]);
    expect(lossKeys(loss)).toEqual(['c:fl:0,0', 'c:fl:3,2', 'p:it_a', 'p:it_b', 'o:fl:4,0,w']);
  });

  it('a placement that only partly leaves the grid is cut', () => {
    const l = {
      ...small(),
      placements: [{ itemId: 's', floorId: 'fl', x: 2, y: 0, rotation: 0 as const }],
    };
    const { loss } = resizeLayout(l, { n: 0, e: -1, s: 0, w: 0 }, () => [2, 1]);
    expect(loss.placements.map((p) => p.itemId)).toEqual(['s']);
  });

  it('on the example house: one column west keeps every item on its room', () => {
    const { layout, loss } = resizeLayout(example, { n: 0, e: 0, s: 0, w: 1 }, fp11);
    expect(lossIsEmpty(loss)).toBe(true);
    for (const p of layout.placements ?? []) {
      const before = example.placements!.find((q) => q.itemId === p.itemId)!;
      const f0 = example.floors.find((f) => f.id === p.floorId)!;
      const f1 = layout.floors.find((f) => f.id === p.floorId)!;
      expect(f1.cells![`${p.x},${p.y}`]).toBe(f0.cells![`${before.x},${before.y}`]);
    }
  });
});

describe('ids and names', () => {
  it('makes room ids that are free', () => {
    let n = 0;
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const id = newRoomId(new Set(['rm_000000']), () => seq[n++]!);
    expect(id).toBe('rm_iiiiii');
    expect(newRoomId(new Set())).toMatch(/^rm_[0-9a-z]{6}$/);
  });

  it('cleans room names and checks colours', () => {
    expect(cleanRoomName('  Big   kitchen ')).toBe('Big kitchen');
    expect(cleanRoomName('   ')).toBeNull();
    expect(cleanRoomName('x'.repeat(101))).toBeNull();
    expect(isRoomColor('#a1B2c3')).toBe(true);
    expect(isRoomColor('red')).toBe(false);
  });
});

describe('another writer resized the house (M5-02)', () => {
  it('finds the shift of an exact resize', () => {
    for (const by of [
      { n: 0, e: 0, s: 0, w: 2 },
      { n: 3, e: 1, s: 0, w: 0 },
      { n: 0, e: -2, s: -1, w: 0 },
      { n: -1, e: 0, s: 0, w: -1 },
    ]) {
      const next = resizeLayout(example, by, fp11).layout;
      expect(inferShift(example, next, fp11)).toEqual({ dx: by.w, dy: by.n });
    }
  });

  it('same size: no shift; a resize mixed with other edits or an empty house: unknown', () => {
    expect(inferShift(example, example, fp11)).toEqual({ dx: 0, dy: 0 });
    const next = resizeLayout(example, { n: 0, e: 0, s: 0, w: 2 }, fp11).layout;
    next.floors[0]!.cells!['0,0'] = 'rm_kit';
    expect(inferShift(example, next, fp11)).toBeNull();
    const empty: Layout = {
      ...small(),
      floors: [{ id: 'fl', name: 'F', level: 0 }],
      placements: [],
      openings: [],
    };
    const grown = resizeLayout(empty, { n: 0, e: 1, s: 0, w: 1 }, fp11).layout;
    expect(inferShift(empty, grown, fp11)).toBeNull();
  });

  it('compares layouts whatever the key order', () => {
    const a = small();
    const b = JSON.parse(
      JSON.stringify({
        ...a,
        floors: a.floors.map((f) => ({ cells: f.cells, level: f.level, name: f.name, id: f.id })),
      }),
    ) as Layout;
    expect(canonicalLayout(a)).toBe(canonicalLayout(b));
    expect(canonicalLayout({ ...a, $schema: 'x' })).toBe(canonicalLayout(a));
    expect(canonicalLayout(resizeLayout(a, { n: 1, e: 0, s: 0, w: 0 }, fp11).layout)).not.toBe(
      canonicalLayout(a),
    );
  });
});

describe('same size, but the house moved (M5-07)', () => {
  it('finds a West +1 / East −1 shift; ordinary edits are not a shift', () => {
    const moved = resizeLayout(example, { n: 0, e: -1, s: 0, w: 1 }, fp11).layout;
    expect(inferShift(example, moved, fp11)).toEqual({ dx: 1, dy: 0 });
    const both = resizeLayout(example, { n: 1, e: -1, s: -1, w: 1 }, fp11).layout;
    expect(inferShift(example, both, fp11)).toEqual({ dx: 1, dy: 1 });
    const painted = structuredClone(example);
    painted.floors[0]!.cells!['0,0'] = 'rm_kit';
    painted.placements![0]!.x += 1;
    expect(inferShift(example, painted, fp11)).toEqual({ dx: 0, dy: 0 });
    // Moved and painted: the shift isn't exactly a resize, so it can't be translated.
    const mixed = structuredClone(moved);
    mixed.floors[0]!.cells!['0,0'] = 'rm_kit';
    expect(inferShift(example, mixed, fp11)).toBeNull();
  });
});

describe('a shift needs tiles or openings to confirm it (M5-11)', () => {
  const bare: Layout = {
    schemaVersion: 2,
    grid: { tileSize: 1, width: 6, depth: 4 },
    rooms: [],
    floors: [{ id: 'fl', name: 'F', level: 0, cells: {} }],
    placements: [
      { itemId: 'a', floorId: 'fl', x: 1, y: 1, rotation: 0 },
      { itemId: 'b', floorId: 'fl', x: 2, y: 2, rotation: 0 },
    ],
  };
  it('items moved by the same amount in an empty house are not a shift', () => {
    const moved = structuredClone(bare);
    for (const p of moved.placements!) p.x += 1;
    expect(inferShift(bare, moved, fp11)).toEqual({ dx: 0, dy: 0 });
  });
  it('a new size without tiles or openings can’t be told apart: unknown', () => {
    const grown = structuredClone(bare);
    grown.grid.width += 1;
    grown.placements![0]!.x += 1;
    expect(inferShift(bare, grown, fp11)).toBeNull();
    expect(inferShift(bare, { ...bare, grid: { ...bare.grid, width: 7 } }, fp11)).toBeNull();
  });
  it('one painted tile is enough to confirm a shift', () => {
    const one: Layout = {
      ...bare,
      floors: [{ id: 'fl', name: 'F', level: 0, cells: { '0,0': 'r' } }],
    };
    const grown = resizeLayout(one, { n: 0, e: 0, s: 0, w: 1 }, fp11).layout;
    expect(inferShift(one, grown, fp11)).toEqual({ dx: 1, dy: 0 });
  });
});

describe('firstLayout (first run, D34)', () => {
  it('one empty floor at level 0 on a grid of 1 m tiles', () => {
    const l = firstLayout('  Ground   floor ', 16, 10, () => 0);
    expect(l).toEqual({
      schemaVersion: 2,
      grid: { tileSize: 1, width: 16, depth: 10 },
      rooms: [],
      floors: [{ id: 'fl_000000', name: 'Ground floor', level: 0, cells: {} }],
      placements: [],
      openings: [],
    });
  });

  it('refuses names and sizes the contract would reject', () => {
    expect(firstLayout('', 16, 10)).toBeNull();
    expect(firstLayout('x'.repeat(101), 16, 10)).toBeNull();
    expect(firstLayout('F', 0, 10)).toBeNull();
    expect(firstLayout('F', 513, 10)).toBeNull();
    expect(firstLayout('F', 10.5, 10)).toBeNull();
    expect(firstLayout('F', Number.NaN, 10)).toBeNull();
    expect(firstLayout('F', 512, 1)).not.toBeNull();
  });
});

describe('edges for doors and windows (D36)', () => {
  it('nearestEdge picks the closest side and stores it as n/w', () => {
    expect(nearestEdge({ x: 2, y: 3, fx: 0.5, fy: 0.1 })).toEqual({ x: 2, y: 3, side: 'n' });
    expect(nearestEdge({ x: 2, y: 3, fx: 0.5, fy: 0.9 })).toEqual({ x: 2, y: 4, side: 'n' }); // south
    expect(nearestEdge({ x: 2, y: 3, fx: 0.1, fy: 0.5 })).toEqual({ x: 2, y: 3, side: 'w' });
    expect(nearestEdge({ x: 2, y: 3, fx: 0.9, fy: 0.5 })).toEqual({ x: 3, y: 3, side: 'w' }); // east
    expect(nearestEdge({ x: 2, y: 3 })).toBeNull();
  });

  it('isWallEdge: between rooms or a room and outside, on the grid', () => {
    const cells = { '0,0': 'a', '1,0': 'a', '2,0': 'b' };
    const grid = { width: 4, depth: 2 };
    expect(isWallEdge(cells, { x: 1, y: 0, side: 'w' }, grid)).toBe(false); // inside room a
    expect(isWallEdge(cells, { x: 2, y: 0, side: 'w' }, grid)).toBe(true); // a | b
    expect(isWallEdge(cells, { x: 0, y: 0, side: 'n' }, grid)).toBe(true); // outside above
    expect(isWallEdge(cells, { x: 0, y: 1, side: 'n' }, grid)).toBe(true); // outside below
    expect(isWallEdge(cells, { x: 3, y: 1, side: 'n' }, grid)).toBe(false); // nothing on either side
    expect(isWallEdge(cells, { x: 9, y: 0, side: 'w' }, grid)).toBe(false); // off the grid
  });
});
