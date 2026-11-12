import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../api/types';
import { buildModel } from '../../store/model';
import { exampleSnapshot } from '../../test/exampleHouse';
import { makeItem } from '../../test/fixtures';
import { emergencySheet, floorBounds, helpOf, sheetFingerprint } from './sheet';

const CRITICAL = new Set(['fuse', 'valve', 'router']);

function snapshot(): Snapshot {
  const s = exampleSnapshot();
  return {
    ...s,
    items: s.items.map((i) => ({ ...i, critical: CRITICAL.has(i.type ?? '') })),
  };
}

describe('emergency sheet (D44)', () => {
  it('lists critical items floor by floor, numbered in reading order, unplaced last', () => {
    const s = snapshot();
    const spare = makeItem({ id: 'it_spare', name: 'Spare valve', type: 'valve', critical: true });
    const model = buildModel({ ...s, items: [...s.items, spare] });
    const sheet = emergencySheet(model);
    const all = [...sheet.floors.flatMap((f) => f.items), ...sheet.unplaced];
    expect(all.map((x) => x.item.name).sort()).toEqual(
      ['Fuse box', 'Main water valve', 'Router', 'Spare valve'].sort(),
    );
    expect(all.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(sheet.count).toBe(4);
    expect(sheet.unplaced.map((x) => x.item.name)).toEqual(['Spare valve']);
    expect(sheet.unplaced[0]!.rect).toBeNull();
    // Only floors with emergency items, in the app's order; reading order within a floor.
    for (const f of sheet.floors) {
      expect(f.items.length).toBeGreaterThan(0);
      const keys = f.items.map((x) => [x.rect!.y, x.rect!.x]);
      expect(keys).toEqual([...keys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    }
    const order = model.floors.map((f) => f.floor.id);
    const shown = sheet.floors.map((f) => f.floor.floor.id);
    expect(shown).toEqual(order.filter((id) => shown.includes(id)));
  });

  it('nothing critical: an empty sheet', () => {
    const s = exampleSnapshot();
    const sheet = emergencySheet(buildModel(s));
    expect(sheet).toMatchObject({ floors: [], unplaced: [], count: 0 });
  });

  it('prints the "Quick help" section, else the note without its maintenance log', () => {
    const log = '## Maintenance log\n- 2026-01-01 serviced\n';
    expect(helpOf(`## Quick help\n- **E1**: reset\n\n## Circuits\n- B1\n\n${log}`)).toBe(
      '- **E1**: reset',
    );
    expect(helpOf(`Turn clockwise.\n\n${log}\n## Circuits\n- B1 Lights`)).toBe(
      'Turn clockwise.\n\n## Circuits\n- B1 Lights',
    );
    expect(helpOf(log)).toBe('');
    expect(helpOf('')).toBe('');
  });

  it('bounds cover the floor’s rooms only', () => {
    const model = buildModel(snapshot());
    for (const f of model.floors) {
      const b = floorBounds(f, model.grid);
      for (const key of f.cells.keys()) {
        const [x, y] = key.split(',').map(Number) as [number, number];
        expect(x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h).toBe(true);
      }
    }
  });

  it('the fingerprint changes with what is printed, not with anything else', () => {
    const base = snapshot();
    const print = (s: Snapshot) => {
      const m = buildModel(s);
      return sheetFingerprint(m, emergencySheet(m));
    };
    const fp = print(base);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(print(snapshot())).toBe(fp); // stable

    const edit = (id: string, over: object): Snapshot => ({
      ...base,
      items: base.items.map((i) => (i.id === id ? { ...i, ...over } : i)),
    });
    const valve = 'it_2v9q6t';
    const oven = 'it_9b3m7x';
    // Printed things: name, quick help, place, a new emergency item.
    expect(print(edit(valve, { name: 'Water stopcock' }))).not.toBe(fp);
    expect(print(edit(valve, { body: '## Quick help\nTurn clockwise.' }))).not.toBe(fp);
    const loc = base.items.find((i) => i.id === valve)!.location!;
    expect(print(edit(valve, { location: { ...loc, x: loc.x + 1 } }))).not.toBe(fp);
    expect(print(edit(oven, { critical: true }))).not.toBe(fp);
    // Not printed: other items, the rest of a note, the date.
    expect(print(edit(oven, { name: 'Big oven' }))).toBe(fp);
    expect(print(edit(valve, { body: '## Maintenance log\n- 2026-01-01 serviced' }))).toBe(fp);
    expect(print({ ...base, today: '2027-01-01' })).toBe(fp);
  });
});
