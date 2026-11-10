import { describe, expect, it } from 'vitest';
import { type Layout, addsProblems, layoutIssues, problemCounts } from '../domain/layout';
import { type ApplyContext, type Command, applyCommand } from './commands';
import { type Applied, replay } from './replay';
import { repairCommand, repairFixes } from './repairs';

const ctx: ApplyContext = { footprintOf: () => [1, 1] };

/** A hand-edited layout with every repairable problem (D30). */
const broken = (): Layout => ({
  schemaVersion: 2,
  grid: { tileSize: 1, width: 4, depth: 3 },
  rooms: [{ id: 'rm_a', name: 'A', color: '#112233' }],
  floors: [
    {
      id: 'fl',
      name: 'F',
      level: 0,
      cells: { '0,0': 'rm_a', '1,0': 'rm_gone', '2,1': 'rm_gone', '5,0': 'rm_a' },
    },
  ],
  placements: [
    { itemId: 'it_a', floorId: 'fl', x: 0, y: 0, rotation: 0 },
    { itemId: 'it_b', floorId: 'fl', x: 1, y: 1, rotation: 0 },
    { itemId: 'it_a', floorId: 'fl', x: 3, y: 2, rotation: 90 },
    { itemId: 'it_c', floorId: 'fl', x: 3, y: 5, rotation: 0 },
    { itemId: 'it_d', floorId: 'fl_gone', x: 0, y: 0, rotation: 0 },
  ],
  openings: [
    { floorId: 'fl', x: 1, y: 0, side: 'n', kind: 'door' },
    { floorId: 'fl', x: 6, y: 1, side: 'w', kind: 'window' },
    { floorId: 'fl_gone', x: 0, y: 0, side: 'n', kind: 'door' },
  ],
});

function ok(l: Layout, cmd: Command) {
  const r = applyCommand(l, cmd, ctx);
  if (!r.ok) throw new Error(`conflict ${r.conflict.code}`);
  return r;
}
/** The repair applies, the issue is gone, and undo gives back exactly the broken layout. */
function fixes(kind: string, fix: Parameters<typeof repairCommand>[2]) {
  const l = broken();
  const issue = layoutIssues(l, ctx.footprintOf).find((i) => i.kind === kind)!;
  expect(repairFixes(issue)).toContain(fix);
  const cmd = repairCommand(l, issue, fix, {
    id: 'rm_new',
    name: 'Recovered room',
    color: '#000000',
  })!;
  const r = ok(l, cmd);
  expect(layoutIssues(r.layout, ctx.footprintOf).map((i) => i.kind)).not.toContain(kind);
  expect(ok(r.layout, r.inverse).layout).toEqual(broken());
  return r.layout;
}

describe('layoutIssues (D30)', () => {
  it('finds each repairable problem with what its fix needs', () => {
    expect(layoutIssues(broken(), ctx.footprintOf)).toEqual([
      {
        kind: 'unknown_room',
        roomId: 'rm_gone',
        cells: [
          { floorId: 'fl', x: 1, y: 0 },
          { floorId: 'fl', x: 2, y: 1 },
        ],
      },
      { kind: 'duplicate_placement', itemId: 'it_a', count: 2 },
      {
        kind: 'outside_grid',
        fit: { width: 6, depth: 6 },
        cells: [{ floorId: 'fl', x: 5, y: 0, roomId: 'rm_a' }],
        itemIds: ['it_c'],
        placements: [{ itemId: 'it_c', floorId: 'fl', x: 3, y: 5, rotation: 0 }],
        openings: [{ floorId: 'fl', x: 6, y: 1, side: 'w', kind: 'window' }],
      },
      {
        kind: 'unknown_floor',
        itemIds: ['it_d'],
        placements: [{ itemId: 'it_d', floorId: 'fl_gone', x: 0, y: 0, rotation: 0 }],
        openings: [{ floorId: 'fl_gone', x: 0, y: 0, side: 'n', kind: 'door' }],
      },
    ]);
  });

  it('a clean layout has none; growing past 512 is not offered', () => {
    const l = broken();
    expect(
      layoutIssues(
        {
          ...l,
          rooms: [],
          floors: [{ id: 'fl', name: 'F', level: 0 }],
          placements: [],
          openings: [],
        },
        ctx.footprintOf,
      ),
    ).toEqual([]);
    const far = { ...l, floors: [{ id: 'fl', name: 'F', level: 0, cells: { '600,0': 'rm_a' } }] };
    const issue = layoutIssues(far, ctx.footprintOf).find((i) => i.kind === 'outside_grid')!;
    expect(issue).toMatchObject({ fit: null });
    expect(repairFixes(issue)).toEqual(['remove_outside']);
  });
});

describe('repairs are ordinary undoable commands', () => {
  it('recreate the missing room (same id, no loss)', () => {
    const after = fixes('unknown_room', 'recreate_room');
    expect(after.rooms).toContainEqual({ id: 'rm_gone', name: 'Recovered room', color: '#000000' });
  });

  it('erase the tiles of the missing room', () => {
    const after = fixes('unknown_room', 'erase_tiles');
    expect(Object.values(after.floors[0]!.cells!)).not.toContain('rm_gone');
  });

  it('keep the first placement of an item placed twice; undo puts the copy back in place', () => {
    const after = fixes('duplicate_placement', 'keep_first');
    expect(after.placements!.filter((p) => p.itemId === 'it_a')).toEqual([
      { itemId: 'it_a', floorId: 'fl', x: 0, y: 0, rotation: 0 },
    ]);
    // Once only: a no-op.
    expect(ok(after, { kind: 'dedupe', itemId: 'it_a' }).changed).toBe(false);
  });

  it('grow to fit, east and south only', () => {
    const after = fixes('outside_grid', 'grow');
    expect(after.grid).toMatchObject({ width: 6, depth: 6 });
    expect(after.floors[0]!.cells!['0,0']).toBe('rm_a');
  });

  it('remove what is outside: tiles erased, items unplaced, openings removed', () => {
    const after = fixes('outside_grid', 'remove_outside');
    expect(after.floors[0]!.cells!['5,0']).toBeUndefined();
    expect(after.placements!.map((p) => p.itemId)).not.toContain('it_c');
    expect(after.openings).toHaveLength(2);
  });

  it('remove what is on a missing floor', () => {
    const after = fixes('unknown_floor', 'remove_unknown_floor');
    expect(after.placements!.map((p) => p.itemId)).not.toContain('it_d');
    expect(after.openings!.map((o) => o.floorId)).not.toContain('fl_gone');
  });

  it('a repair replays after a 412, and is a no-op if someone fixed it meanwhile', () => {
    const l = broken();
    const issue = layoutIssues(l, ctx.footprintOf)[0]!;
    const cmd = repairCommand(l, issue, 'erase_tiles')!;
    const rec: Applied = { entryId: 1, dir: 'do', cmd };
    const theirs = broken();
    theirs.rooms!.push({ id: 'rm_x', name: 'X', color: '#000000' });
    const r = replay(theirs, [rec], ctx);
    expect(r.dropped).toEqual([]);
    expect(r.layout.rooms).toHaveLength(2);
    expect(Object.values(r.layout.floors[0]!.cells!)).not.toContain('rm_gone');
    const fixed = ok(broken(), cmd).layout;
    expect(replay(fixed, [rec], ctx).kept[0]!.changed).toBe(false);
  });

  it('ordinary edits still can’t create these problems', () => {
    expect(
      applyCommand(broken(), { kind: 'cells', floorId: 'fl', set: [[9, 0, 'rm_a']] }, ctx).ok,
    ).toBe(false);
    expect(
      applyCommand(broken(), { kind: 'cells', floorId: 'fl', set: [[0, 1, 'rm_gone']] }, ctx).ok,
    ).toBe(false);
  });
});

describe('problem counts (the server’s D30 rule)', () => {
  it('counts per subject; a repair has fewer, its undo more', () => {
    const l = broken();
    expect(Object.fromEntries(problemCounts(l, ctx.footprintOf))).toEqual({
      'room:fl:rm_gone': 2,
      'dup:it_a': 1,
      'out:fl': 2,
      'out-item:it_c': 1,
      'floor:fl_gone': 1,
      'floor-item:it_d': 1,
    });
    const issue = layoutIssues(l, ctx.footprintOf)[0]!;
    const fixed = ok(l, repairCommand(l, issue, 'erase_tiles')!).layout;
    expect(addsProblems(fixed, l, ctx.footprintOf)).toBe(false);
    expect(addsProblems(l, fixed, ctx.footprintOf)).toBe(true);
    // Moving a bad tile elsewhere keeps the count: not worse.
    const moved = structuredClone(l);
    delete moved.floors[0]!.cells!['1,0'];
    moved.floors[0]!.cells!['3,0'] = 'rm_gone';
    expect(addsProblems(moved, l, ctx.footprintOf)).toBe(false);
  });
});

describe('round 2 (M5-08, M5-09)', () => {
  it('a missing room whose id isn’t valid is recreated under a new id; undo puts it back', () => {
    const l = broken();
    l.floors[0]!.cells!['1,0'] = 'Garage room';
    l.floors[0]!.cells!['2,1'] = 'Garage room';
    const issue = layoutIssues(l, ctx.footprintOf).find((i) => i.kind === 'unknown_room')!;
    const cmd = repairCommand(l, issue, 'recreate_room', {
      id: 'rm_new',
      name: 'Garage room',
      color: '#000000',
    })!;
    const r = ok(l, cmd);
    expect(r.layout.rooms).toContainEqual({ id: 'rm_new', name: 'Garage room', color: '#000000' });
    expect(r.layout.floors[0]!.cells).toMatchObject({ '1,0': 'rm_new', '2,1': 'rm_new' });
    expect(layoutIssues(r.layout, ctx.footprintOf).map((i) => i.kind)).not.toContain(
      'unknown_room',
    );
    expect(ok(r.layout, r.inverse).layout).toEqual(l);
  });

  it('removing what is outside takes the copy outside, not the item’s good placement', () => {
    const l = broken();
    l.placements!.push({ itemId: 'it_b', floorId: 'fl', x: 9, y: 9, rotation: 0 });
    l.placements!.push({ itemId: 'it_b', floorId: 'fl_gone', x: 1, y: 1, rotation: 0 });
    for (const [kind, fix] of [
      ['outside_grid', 'remove_outside'],
      ['unknown_floor', 'remove_unknown_floor'],
    ] as const) {
      const issue = layoutIssues(l, ctx.footprintOf).find((i) => i.kind === kind)!;
      const r = ok(l, repairCommand(l, issue, fix)!);
      expect(r.layout.placements!.filter((p) => p.itemId === 'it_b')).toContainEqual({
        itemId: 'it_b',
        floorId: 'fl',
        x: 1,
        y: 1,
        rotation: 0,
      });
      expect(layoutIssues(r.layout, ctx.footprintOf).map((i) => i.kind)).not.toContain(kind);
      expect(ok(r.layout, r.inverse).layout).toEqual(l);
    }
  });
});
