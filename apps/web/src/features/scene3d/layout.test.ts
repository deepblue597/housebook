import { describe, expect, it } from 'vitest';
import { cellKey } from '../../domain/coords';
import { CEILING_HEIGHT, CUT_HEIGHT, WALL_ITEM_TOP, worldToCell } from '../../domain/scene';
import { buildModel } from '../../store/model';
import { exampleSnapshot, house } from '../../test/exampleHouse';
import { itemTop, sceneLayout, wallMeshes } from './layout';

const model = buildModel(exampleSnapshot());
const apartment = model.floorById.get('fl_0')!;

describe('scene layout (examples/house)', () => {
  const layout = sceneLayout(model, apartment, CUT_HEIGHT);

  it('one room entry per painted room, labels on a tile of that room', () => {
    expect(layout.rooms.map((r) => r.roomId).sort()).toEqual(
      [...new Set(apartment.cells.values())].sort(),
    );
    for (const r of layout.rooms) {
      const c = worldToCell(r.label.x - 0.01, r.label.z - 0.01, layout.tileSize);
      const c2 = worldToCell(r.label.x + 0.01, r.label.z + 0.01, layout.tileSize);
      const rooms = [
        apartment.cells.get(cellKey(c.x, c.y)),
        apartment.cells.get(cellKey(c2.x, c2.y)),
      ];
      expect(rooms, r.name).toContain(r.roomId);
    }
  });

  it('every placed item on the floor is in the scene, on its own tile', () => {
    expect(layout.items.map((i) => i.id).sort()).toEqual(apartment.items.map((i) => i.id).sort());
    for (const it of layout.items) {
      const loc = it.item.location!;
      expect(it.transform.rect).toMatchObject({ x: loc.x, y: loc.y });
      const top = itemTop(it.transform);
      expect(top.y).toBeCloseTo(it.transform.position.y + it.transform.size.y / 2);
    }
  });

  it('mount decides height: wall items hang, ceiling items at the top, floor items stand', () => {
    const byId = new Map(layout.items.map((i) => [i.id, i]));
    expect(byId.get('it_4f8k2q')!.mount).toBe('floor'); // fridge
    expect(byId.get('it_4f8k2q')!.transform.position.y).toBeCloseTo(0.9);
    expect(byId.get('it_7n3d8f')!.mount).toBe('wall'); // fuse box
    expect(byId.get('it_4g6y1r')!.mount).toBe('ceiling'); // smoke detector
    const smoke = byId.get('it_4g6y1r')!.transform;
    expect(smoke.position.y + smoke.size.y / 2).toBeCloseTo(CEILING_HEIGHT);
    const fuse = byId.get('it_7n3d8f')!.transform;
    expect(fuse.position.y + fuse.size.y / 2).toBeCloseTo(WALL_ITEM_TOP);
  });

  it('toggling walls up moves no item (wall and ceiling items keep their real height)', () => {
    const up = sceneLayout(model, apartment, CEILING_HEIGHT);
    expect(up.items.map((i) => i.transform)).toEqual(layout.items.map((i) => i.transform));
  });

  it('bounds hug the painted cells, and reach up to the highest wall or item', () => {
    expect(layout.bounds.min).toEqual({ x: 1, y: 0, z: 1 });
    const tops = layout.items.map((i) => itemTop(i.transform).y);
    expect(layout.bounds.max.y).toBeCloseTo(Math.max(CUT_HEIGHT, ...tops));
    expect(layout.bounds.max.x).toBeLessThanOrEqual(house.grid.width);
  });

  it('honours a placement footprint override', () => {
    const snap = exampleSnapshot();
    snap.house = {
      ...snap.house!,
      placements: snap.house!.placements!.map((p) =>
        p.itemId === 'it_4f8k2q' ? { ...p, footprint: [2, 1] as [number, number] } : p,
      ),
    };
    const m = buildModel(snap);
    const fridge = sceneLayout(m, m.floorById.get('fl_0')!, CUT_HEIGHT).items.find(
      (i) => i.id === 'it_4f8k2q',
    )!;
    expect(fridge.transform.rect).toEqual({ x: 8, y: 1, w: 2, h: 1 });
    expect(fridge.transform.position.x).toBe(9);
  });

  it('cut-away walls hide nothing: one solid mesh, nothing faded, at any heading', () => {
    for (const heading of ['north', 'east', 'south', 'west'] as const) {
      const wm = wallMeshes(layout, apartment.cells, heading);
      expect(wm.solid).toBe(layout.walls);
      expect(wm.faded).toEqual([]);
    }
  });

  it('walls up: walls facing the camera keep a cut-height base and fade above it', () => {
    const up = sceneLayout(model, apartment, CEILING_HEIGHT);
    const top = (b: { y: number; sy: number }) => b.y + b.sy / 2;
    const bottom = (b: { y: number; sy: number }) => b.y - b.sy / 2;
    const sets = new Map<string, string>();
    for (const heading of ['north', 'east', 'south', 'west'] as const) {
      const wm = wallMeshes(up, apartment.cells, heading);
      expect(wm.faded.length).toBeGreaterThan(0);
      for (const b of wm.faded) expect(bottom(b)).toBeGreaterThanOrEqual(CUT_HEIGHT - 1e-9);
      // Every wall still reaches the cut height somewhere solid (rooms stay outlined), and
      // the solid ones that aren't bases go all the way up.
      expect(wm.solid.some((b) => top(b) > CUT_HEIGHT + 1e-9)).toBe(true);
      sets.set(heading, JSON.stringify(wm.faded));
    }
    // Which walls fade follows the heading.
    expect(new Set(sets.values()).size).toBe(4);
  });
});

describe('scene layout: missing notes', () => {
  it('a placement whose note is gone is a ghost on its tile, not an item', () => {
    const snap = exampleSnapshot();
    const gone = snap.items.find((i) => i.location?.floorId === 'fl_0')!;
    const m = buildModel({ ...snap, items: snap.items.filter((i) => i !== gone) });
    const layout = sceneLayout(m, m.floorById.get('fl_0')!, CUT_HEIGHT);
    expect(layout.items.map((i) => i.id)).not.toContain(gone.id);
    expect(layout.ghosts.map((g) => g.id)).toEqual([gone.id]);
    const p = house.placements!.find((x) => x.itemId === gone.id)!;
    const t = layout.ghosts[0]!.transform;
    const cell = worldToCell(t.position.x, t.position.z, layout.tileSize);
    expect(cell.x).toBeGreaterThanOrEqual(p.x);
    expect(cell.y).toBeGreaterThanOrEqual(p.y);
  });
});
