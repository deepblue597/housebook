import { describe, expect, it } from 'vitest';
import type { Layout } from '../domain/layout';
import { lossKeys, resizeLayout } from '../domain/layout';
import { house as exampleHouse } from '../test/exampleHouse';
import { type ApplyContext, type Command, applyCommand, setCells, shiftCommand } from './commands';
import { type Applied, replay } from './replay';

const ctx: ApplyContext = { footprintOf: () => [1, 1] };
const example = (): Layout => structuredClone<Layout>(exampleHouse);

const base = (): Layout => ({
  schemaVersion: 1,
  grid: { tileSize: 1, width: 5, depth: 4 },
  rooms: [
    { id: 'rm_a', name: 'A', color: '#112233' },
    { id: 'rm_b', name: 'B', color: '#445566' },
  ],
  floors: [
    { id: 'fl', name: 'F', level: 0, cells: { '0,0': 'rm_a', '1,0': 'rm_a', '4,3': 'rm_b' } },
    { id: 'fl2', name: 'G', level: 1, cells: {} },
  ],
  placements: [
    { itemId: 'it_a', floorId: 'fl', x: 0, y: 0, rotation: 0 },
    { itemId: 'it_b', floorId: 'fl', x: 4, y: 3, rotation: 90 },
  ],
  openings: [{ floorId: 'fl', x: 5, y: 3, side: 'w', kind: 'door' }],
});

function ok(l: Layout, cmd: Command) {
  const r = applyCommand(l, cmd, ctx);
  if (!r.ok) throw new Error(`conflict ${r.conflict.code}`);
  return r;
}
function conflict(l: Layout, cmd: Command) {
  const r = applyCommand(l, cmd, ctx);
  if (r.ok) throw new Error('expected a conflict');
  return r.conflict;
}

/** apply then undo gives back the same layout (DESIGN 15.15: undo(apply(s)) == s). */
function roundTrip(l: Layout, cmd: Command) {
  const before = structuredClone(l);
  const r = ok(l, cmd);
  expect(l).toEqual(before); // never mutated
  const back = ok(r.layout, r.inverse);
  expect(normal(back.layout)).toEqual(normal(before));
  // ... and redo with the inverse's inverse gives the edited layout again.
  expect(normal(ok(back.layout, back.inverse).layout)).toEqual(normal(r.layout));
  return r;
}

/** Order of cell keys doesn't matter (the server sorts them when it writes). */
const normal = (l: Layout) => ({
  ...l,
  floors: l.floors.map((f) => ({
    ...f,
    cells: Object.fromEntries(Object.entries(f.cells ?? {}).sort()),
  })),
});

describe('cells (paint, erase, rectangle)', () => {
  it('paints and erases a rectangle as one command, and undoes exactly', () => {
    const cells = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ];
    const r = roundTrip(base(), setCells('fl', cells, 'rm_b'));
    expect(r.layout.floors[0]!.cells).toMatchObject({
      '0,0': 'rm_b',
      '2,0': 'rm_b',
      '0,1': 'rm_b',
    });
    const e = roundTrip(base(), setCells('fl', cells, null));
    expect(e.layout.floors[0]!.cells).toEqual({ '4,3': 'rm_b' });
  });

  it('paint then erase restores the original', () => {
    const cells = [{ x: 3, y: 2 }];
    const painted = ok(base(), setCells('fl', cells, 'rm_a')).layout;
    const erased = ok(painted, setCells('fl', cells, null)).layout;
    expect(normal(erased)).toEqual(normal(base()));
  });

  it('is a no-op when nothing changes', () => {
    const l = base();
    const r = ok(l, setCells('fl', [{ x: 0, y: 0 }], 'rm_a'));
    expect(r.changed).toBe(false);
    expect(r.layout).toBe(l);
  });

  it('conflicts: unknown floor or room, outside the grid', () => {
    expect(conflict(base(), setCells('nope', [{ x: 0, y: 0 }], 'rm_a'))).toEqual({
      code: 'floor_missing',
      subject: 'nope',
    });
    expect(conflict(base(), setCells('fl', [{ x: 0, y: 0 }], 'rm_zz')).code).toBe('room_missing');
    expect(conflict(base(), setCells('fl', [{ x: 5, y: 0 }], 'rm_a')).code).toBe('outside_grid');
  });
});

describe('placements (place, move, rotate, remove)', () => {
  it('moves and rotates an item, keeping the stacking order', () => {
    const to = { itemId: 'it_a', floorId: 'fl', x: 2, y: 1, rotation: 90 as const };
    const r = roundTrip(base(), { kind: 'placement', itemId: 'it_a', to, requires: 'placed' });
    expect(r.layout.placements!.map((p) => p.itemId)).toEqual(['it_a', 'it_b']);
    expect(r.layout.placements![0]).toEqual(to);
  });

  it('places an unplaced item and removes a placed one', () => {
    const to = { itemId: 'it_new', floorId: 'fl2', x: 1, y: 1, rotation: 0 as const };
    const placed = roundTrip(base(), {
      kind: 'placement',
      itemId: 'it_new',
      to,
      requires: 'unplaced',
    });
    expect(placed.layout.placements).toHaveLength(3);
    const removed = roundTrip(base(), {
      kind: 'placement',
      itemId: 'it_b',
      to: null,
      requires: 'placed',
    });
    expect(removed.layout.placements!.map((p) => p.itemId)).toEqual(['it_a']);
  });

  it('conflicts: moving something removed elsewhere, placing something placed elsewhere', () => {
    expect(
      conflict(base(), {
        kind: 'placement',
        itemId: 'it_zz',
        to: { itemId: 'it_zz', floorId: 'fl', x: 1, y: 1, rotation: 0 },
        requires: 'placed',
      }),
    ).toEqual({ code: 'not_placed', subject: 'it_zz' });
    expect(
      conflict(base(), {
        kind: 'placement',
        itemId: 'it_a',
        to: { itemId: 'it_a', floorId: 'fl', x: 3, y: 3, rotation: 0 },
        requires: 'unplaced',
      }).code,
    ).toBe('already_placed');
    expect(
      conflict(base(), {
        kind: 'placement',
        itemId: 'it_a',
        to: { itemId: 'it_a', floorId: 'gone', x: 0, y: 0, rotation: 0 },
        requires: 'placed',
      }).code,
    ).toBe('floor_missing');
  });

  it('respects the footprint anchor rule when checking the grid', () => {
    const wide: ApplyContext = { footprintOf: () => [3, 1] };
    const cmd: Command = {
      kind: 'placement',
      itemId: 'it_a',
      to: { itemId: 'it_a', floorId: 'fl', x: 3, y: 0, rotation: 0 },
      requires: 'placed',
    };
    expect(applyCommand(base(), cmd, wide).ok).toBe(false);
    // Rotated, the same 3×1 item is 1×3 and fits at x = 3.
    const rotated = { ...cmd, to: { ...cmd.to!, rotation: 90 as const } };
    expect(applyCommand(base(), rotated, wide).ok).toBe(true);
  });

  it('is idempotent: placing what is already there is a no-op, not a conflict', () => {
    const p = base().placements![0]!;
    const r = ok(base(), { kind: 'placement', itemId: p.itemId, to: p, requires: 'unplaced' });
    expect(r.changed).toBe(false);
    expect(
      ok(base(), { kind: 'placement', itemId: 'zz', to: null, requires: 'placed' }).changed,
    ).toBe(false);
  });
});

describe('items whose note this app deleted (D32)', () => {
  const gone: ApplyContext = { ...ctx, noteDeleted: (id) => id === 'it_gone' };
  const at = { floorId: 'fl', x: 2, y: 1, rotation: 0 } as const;

  it('can’t be placed again (an undo after a delete fails instead of making a ghost)', () => {
    const l = base();
    const r = applyCommand(
      l,
      {
        kind: 'placement',
        itemId: 'it_gone',
        to: { itemId: 'it_gone', ...at },
        requires: 'unplaced',
      },
      gone,
    );
    expect(r.ok ? null : r.conflict).toEqual({ code: 'note_deleted', subject: 'it_gone' });
  });

  it('a placement already there can still be moved or removed, and repairs still apply', () => {
    const l = base();
    l.placements = [
      ...l.placements!,
      { itemId: 'it_gone', floorId: 'fl', x: 1, y: 1, rotation: 0 },
    ];
    const move = applyCommand(
      l,
      {
        kind: 'placement',
        itemId: 'it_gone',
        to: { itemId: 'it_gone', ...at },
        requires: 'placed',
      },
      gone,
    );
    expect(move.ok).toBe(true);
    const remove = applyCommand(
      l,
      { kind: 'placement', itemId: 'it_gone', to: null, requires: 'placed' },
      gone,
    );
    expect(remove.ok).toBe(true);
    const repairUndo = applyCommand(
      base(),
      {
        kind: 'placement',
        itemId: 'it_gone',
        to: { itemId: 'it_gone', ...at },
        requires: 'unplaced',
        repair: true,
      },
      gone,
    );
    expect(repairUndo.ok).toBe(true);
  });

  it('other items, including ghosts (note missing, not deleted here), place as before', () => {
    expect(
      ok(base(), {
        kind: 'placement',
        itemId: 'it_new',
        to: { itemId: 'it_new', ...at },
        requires: 'unplaced',
      }).changed,
    ).toBe(true);
  });
});

describe('rooms', () => {
  it('add, rename, recolour, remove', () => {
    const added = roundTrip(base(), {
      kind: 'room.add',
      room: { id: 'rm_c', name: 'C', color: '#000000' },
    });
    expect(added.layout.rooms).toHaveLength(3);
    const renamed = roundTrip(base(), { kind: 'room.update', id: 'rm_a', name: 'Kitchen' });
    expect(renamed.layout.rooms![0]).toEqual({ id: 'rm_a', name: 'Kitchen', color: '#112233' });
    const recoloured = roundTrip(base(), { kind: 'room.update', id: 'rm_a', color: '#abcdef' });
    expect(recoloured.layout.rooms![0]!.color).toBe('#abcdef');
    expect(recoloured.inverse).toEqual({ kind: 'room.update', id: 'rm_a', color: '#112233' });
    const empty = ok(base(), setCells('fl', [{ x: 4, y: 3 }], null)).layout;
    roundTrip(empty, { kind: 'room.remove', id: 'rm_b' });
  });

  it('conflicts: a room in use, a missing room, an id taken by another room', () => {
    expect(conflict(base(), { kind: 'room.remove', id: 'rm_b' })).toEqual({
      code: 'room_in_use',
      subject: 'rm_b',
    });
    expect(conflict(base(), { kind: 'room.update', id: 'rm_zz', name: 'x' }).code).toBe(
      'room_missing',
    );
    expect(
      conflict(base(), { kind: 'room.add', room: { id: 'rm_a', name: 'Other', color: '#000000' } })
        .code,
    ).toBe('room_exists');
    // The same room again is a no-op (a save whose response got lost).
    expect(ok(base(), { kind: 'room.add', room: base().rooms![0]! }).changed).toBe(false);
  });
});

describe('resize (D17b)', () => {
  it('grow north/west: one step, undone exactly', () => {
    const r = roundTrip(base(), {
      kind: 'resize',
      from: { width: 5, depth: 4 },
      by: { n: 1, e: 0, s: 0, w: 2 },
      allowLoss: [],
    });
    expect(r.layout.grid).toMatchObject({ width: 7, depth: 5 });
    expect(r.layout.floors[0]!.cells).toMatchObject({ '2,1': 'rm_a', '6,4': 'rm_b' });
    expect(r.layout.openings).toEqual([{ floorId: 'fl', x: 7, y: 4, side: 'w', kind: 'door' }]);
  });

  it('shrink: needs the loss confirmed; undo restores tiles, placements and openings', () => {
    const by = { n: 0, e: -1, s: -1, w: 0 };
    const cmd: Command = { kind: 'resize', from: { width: 5, depth: 4 }, by, allowLoss: [] };
    expect(conflict(base(), cmd).code).toBe('more_lost');
    const keys = lossKeys(resizeLayout(base(), by, ctx.footprintOf).loss);
    expect(keys).toEqual(['c:fl:4,3', 'p:it_b', 'o:fl:5,3,w']);
    const r = roundTrip(base(), { ...cmd, allowLoss: keys });
    expect(r.layout.grid).toMatchObject({ width: 4, depth: 3 });
    expect(r.layout.placements!.map((p) => p.itemId)).toEqual(['it_a']);
    expect(r.layout.openings).toEqual([]);
  });

  it('undoing a shrink puts cut placements back in their stacking order', () => {
    const l = base();
    l.placements!.push({ itemId: 'it_c', floorId: 'fl', x: 0, y: 1, rotation: 0 });
    l.placements!.reverse(); // it_c, it_b, it_a
    const by = { n: 0, e: -1, s: 0, w: 0 };
    const keys = lossKeys(resizeLayout(l, by, ctx.footprintOf).loss);
    roundTrip(l, { kind: 'resize', from: { width: 5, depth: 4 }, by, allowLoss: keys });
  });

  it('conflicts when the grid was resized elsewhere; already applied is a no-op', () => {
    const cmd: Command = {
      kind: 'resize',
      from: { width: 5, depth: 4 },
      by: { n: 0, e: 1, s: 0, w: 0 },
      allowLoss: [],
    };
    const other = { ...base(), grid: { tileSize: 1, width: 9, depth: 4 } };
    expect(conflict(other, cmd).code).toBe('grid_changed');
    const done = ok(base(), cmd).layout;
    expect(ok(done, cmd).changed).toBe(false);
    expect(conflict(base(), { ...cmd, by: { n: 0, e: -5, s: 0, w: 0 } }).code).toBe('size_invalid');
  });

  it('on the example house: grow every side then undo', () => {
    const l = example();
    roundTrip(l, {
      kind: 'resize',
      from: { width: l.grid.width, depth: l.grid.depth },
      by: { n: 2, e: 1, s: 3, w: 4 },
      allowLoss: [],
    });
  });
});

describe('resize undo keeps house.json order (M5-05)', () => {
  it('cut doors and windows go back to their old places in the list', () => {
    const l = example();
    const by = { n: 0, e: -2, s: 0, w: 0 };
    const keys = lossKeys(resizeLayout(l, by, ctx.footprintOf).loss);
    const r = ok(l, { kind: 'resize', from: { width: 16, depth: 10 }, by, allowLoss: keys });
    const back = ok(r.layout, r.inverse).layout;
    expect(back.openings).toEqual(l.openings);
    expect(back.placements).toEqual(l.placements);
  });
});

describe('shifting commands into a moved grid (M5-02)', () => {
  it('moves coordinates of cells, placements and openings, not resizes or rooms', () => {
    expect(shiftCommand(setCells('fl', [{ x: 1, y: 2 }], 'rm_a'), 2, 1)).toEqual(
      setCells('fl', [{ x: 3, y: 3 }], 'rm_a'),
    );
    const p = { itemId: 'a', floorId: 'fl', x: 1, y: 1, rotation: 0 as const };
    expect(
      shiftCommand(
        {
          kind: 'batch',
          commands: [{ kind: 'placement', itemId: 'a', to: p, requires: 'placed' }],
        },
        -1,
        0,
      ),
    ).toEqual({
      kind: 'batch',
      commands: [{ kind: 'placement', itemId: 'a', to: { ...p, x: 0 }, requires: 'placed' }],
    });
    const o = { floorId: 'fl', x: 1, y: 1, side: 'n' as const, kind: 'door' as const };
    expect(shiftCommand({ kind: 'openings', add: [o], remove: [] }, 0, 2)).toEqual({
      kind: 'openings',
      add: [{ ...o, y: 3 }],
      remove: [],
    });
    const resize: Command = {
      kind: 'resize',
      from: { width: 5, depth: 4 },
      by: { n: 1, e: 0, s: 0, w: 0 },
      allowLoss: [],
    };
    expect(shiftCommand(resize, 3, 3)).toBe(resize);
  });
});

describe('batch', () => {
  it('relink a ghost: remove one placement, add another, as one step', () => {
    const p = base().placements![0]!;
    const r = roundTrip(base(), {
      kind: 'batch',
      commands: [
        { kind: 'placement', itemId: 'it_a', to: null, requires: 'placed' },
        { kind: 'placement', itemId: 'it_c', to: { ...p, itemId: 'it_c' }, requires: 'unplaced' },
      ],
    });
    expect(r.layout.placements!.map((q) => q.itemId).sort()).toEqual(['it_b', 'it_c']);
  });

  it('is all or nothing', () => {
    const l = base();
    const c = conflict(l, {
      kind: 'batch',
      commands: [
        setCells('fl', [{ x: 2, y: 2 }], 'rm_a'),
        setCells('fl', [{ x: 2, y: 2 }], 'rm_zz'),
      ],
    });
    expect(c.code).toBe('room_missing');
  });
});

describe('random edit sequences: undoing everything restores the start', () => {
  // A small deterministic PRNG (no property-testing dependency).
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', (seed) => {
    const rand = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const start = example();
    let l = start;
    const inverses: Command[] = [];
    for (let i = 0; i < 40; i++) {
      const floor = pick(l.floors);
      const rooms = l.rooms ?? [];
      const x = Math.floor(rand() * l.grid.width);
      const y = Math.floor(rand() * l.grid.depth);
      const placement = pick(l.placements ?? []);
      const options: Command[] = [
        setCells(
          floor.id,
          [
            { x, y },
            { x: Math.max(0, x - 1), y },
          ],
          rand() < 0.3 ? null : pick(rooms).id,
        ),
        {
          kind: 'placement',
          itemId: placement.itemId,
          to: { ...placement, floorId: floor.id, x, y, rotation: pick([0, 90, 180, 270] as const) },
          requires: 'placed',
        },
        { kind: 'room.update', id: pick(rooms).id, name: `R${i}` },
        {
          kind: 'resize',
          from: { width: l.grid.width, depth: l.grid.depth },
          by: { n: pick([0, 1]), e: pick([0, 2]), s: 0, w: pick([0, 1]) },
          allowLoss: [],
        },
      ];
      const r = applyCommand(l, pick(options), ctx);
      if (!r.ok) continue;
      l = r.layout;
      inverses.unshift(r.inverse);
    }
    for (const inv of inverses) l = ok(l, inv).layout;
    expect(normal(l)).toEqual(normal(start));
  });
});

describe('replay on 412', () => {
  const rec = (entryId: number, cmd: Command, dir: Applied['dir'] = 'do'): Applied => ({
    entryId,
    dir,
    cmd,
  });

  it('re-applies pending commands on the fresh layout with new inverses', () => {
    const server = base();
    server.floors[0]!.cells!['3,3'] = 'rm_a'; // someone else painted a tile
    const r = replay(
      server,
      [
        rec(1, setCells('fl', [{ x: 3, y: 3 }], 'rm_b')),
        rec(2, setCells('fl', [{ x: 2, y: 2 }], 'rm_a')),
      ],
      ctx,
    );
    expect(r.dropped).toEqual([]);
    expect(r.kept.map((k) => k.changed)).toEqual([true, true]);
    expect(r.layout.floors[0]!.cells).toMatchObject({ '3,3': 'rm_b', '2,2': 'rm_a' });
    // The inverse now restores the other writer's tile, not the old empty one.
    expect(r.kept[0]!.inverse).toEqual({ kind: 'cells', floorId: 'fl', set: [[3, 3, 'rm_a']] });
  });

  it('drops what no longer applies, and everything after it of the same entry', () => {
    const server = base();
    server.rooms = server.rooms!.filter((r) => r.id !== 'rm_a');
    for (const f of server.floors)
      for (const [k, v] of Object.entries(f.cells ?? {})) if (v === 'rm_a') delete f.cells![k];
    const paint = setCells('fl', [{ x: 2, y: 2 }], 'rm_a');
    const r = replay(
      server,
      [
        rec(1, paint),
        rec(2, setCells('fl', [{ x: 3, y: 2 }], 'rm_b')),
        rec(1, setCells('fl', [{ x: 2, y: 2 }], null), 'undo'),
      ],
      ctx,
    );
    expect(r.kept.map((k) => k.rec.entryId)).toEqual([2]);
    expect(r.dropped).toEqual([
      { rec: rec(1, paint), conflict: { code: 'room_missing', subject: 'rm_a' } },
      { rec: rec(1, setCells('fl', [{ x: 2, y: 2 }], null), 'undo'), conflict: null },
    ]);
    expect(r.layout.floors[0]!.cells!['3,2']).toBe('rm_b');
  });
});

describe('replay after a lost save response (M5-01)', () => {
  it('an edit already on the server replays as unchanged', () => {
    const paint = setCells('fl', [{ x: 2, y: 2 }], 'rm_a');
    const server = ok(base(), paint).layout;
    const r = replay(server, [{ entryId: 1, dir: 'do', cmd: paint }], ctx);
    expect(r.kept[0]!.changed).toBe(false);
  });

  it('after a dropped resize every later command is dropped too', () => {
    const resize: Command = {
      kind: 'resize',
      from: { width: 9, depth: 9 },
      by: { n: 1, e: 0, s: 0, w: 0 },
      allowLoss: [],
    };
    const r = replay(
      base(),
      [
        { entryId: 1, dir: 'do', cmd: resize },
        { entryId: 2, dir: 'do', cmd: setCells('fl', [{ x: 0, y: 1 }], 'rm_a') },
      ],
      ctx,
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped.map((d) => d.conflict?.code ?? null)).toEqual(['grid_changed', null]);
  });
});
