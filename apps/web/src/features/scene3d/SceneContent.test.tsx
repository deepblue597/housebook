/**
 * Scene-graph tests (DESIGN 15.15): the 3D scene for examples/house rendered with
 * @react-three/test-renderer, no GPU. Walls are one merged mesh, rooms one mesh each, items
 * sit where the layout says, selection shows, clicks select.
 */
import ReactThreeTestRenderer from '@react-three/test-renderer';
import type { Group, Mesh } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CEILING_HEIGHT, CUT_HEIGHT, WALL_ITEM_TOP, boxesMesh } from '../../domain/scene';
import { buildModel } from '../../store/model';
import { exampleSnapshot } from '../../test/exampleHouse';
import { sceneLayout } from './layout';
import { scenePalette } from './palette';
import { SceneContent, type SceneContentProps } from './SceneContent';

const model = buildModel(exampleSnapshot());
const apartment = model.floorById.get('fl_0')!;
const basement = model.floorById.get('fl_b1')!;

function props(over: Partial<SceneContentProps> = {}, floor = apartment, wallHeight = CUT_HEIGHT) {
  return {
    layout: sceneLayout(model, floor, wallHeight),
    cells: floor.cells,
    heading: 'north' as const,
    snapshot: model.snapshot,
    palette: scenePalette('light'),
    selectedItemId: null,
    selectedRoomId: null,
    matches: null,
    hoverId: null,
    onHover: vi.fn(),
    onItem: vi.fn(),
    onRoom: vi.fn(),
    ...over,
  } satisfies SceneContentProps;
}

async function render(p: SceneContentProps) {
  return ReactThreeTestRenderer.create(<SceneContent {...p} />);
}

const objects = (r: Awaited<ReturnType<typeof render>>) => {
  const all: { name: string; instance: unknown }[] = [];
  r.scene.instance.traverse((o) => all.push({ name: o.name, instance: o }));
  return all;
};

describe('3D scene graph (examples/house)', () => {
  it('draws the selected floor only: one merged wall mesh, one floor mesh per room, every item', async () => {
    const p = props();
    const r = await render(p);
    const names = objects(r).map((o) => o.name);
    expect(names.filter((n) => n === 'walls')).toHaveLength(1);
    const rooms = [...new Set(apartment.cells.values())].sort();
    expect(names.filter((n) => n.startsWith('floor:')).sort()).toEqual(
      rooms.map((id) => `floor:${id}`),
    );
    expect(names.filter((n) => n.startsWith('item:')).sort()).toEqual(
      apartment.items.map((i) => `item:${i.id}`).sort(),
    );
    expect(names).not.toContain('item:it_9p2x5c'); // the basement freezer

    // The wall mesh is all wall boxes in one geometry (one draw call).
    const walls = objects(r).find((o) => o.name === 'walls')!.instance as Mesh;
    const geo = walls.geometry;
    expect(geo.index!.count).toBe(boxesMesh(p.layout.walls).indices.length);
    expect(geo.index!.count).toBe(p.layout.walls.length * 36);
    geo.computeBoundingBox();
    expect(geo.boundingBox!.max.y).toBeCloseTo(CUT_HEIGHT);
    // Window panes are their own translucent mesh.
    expect(names.filter((n) => n === 'glass')).toHaveLength(1);
    await r.unmount();
  });

  it('places and rotates items as the layout says (house y → three z, rotation.y = −r)', async () => {
    const p = props();
    const r = await render(p);
    for (const it of p.layout.items) {
      const g = objects(r).find((o) => o.name === `item:${it.id}`)!.instance as Group;
      expect(g.position.toArray()).toEqual([
        it.transform.position.x,
        it.transform.position.y,
        it.transform.position.z,
      ]);
      expect(g.rotation.y).toBeCloseTo(-((it.item.location!.rotation * Math.PI) / 180), 12);
    }
    // Dishwasher: (10, 2) at 90° → centre of tile, front facing west.
    const dish = objects(r).find((o) => o.name === 'item:it_7f3k2a')!.instance as Group;
    expect([dish.position.x, dish.position.z]).toEqual([10.5, 2.5]);
    expect(dish.rotation.y).toBeCloseTo(-Math.PI / 2, 12);
    // Living room AC (3, 1) at 0°, wall-mounted: against the north edge, under the cut height.
    const ac = objects(r).find((o) => o.name === 'item:it_3a9c4l')!.instance as Group;
    expect(ac.position.x).toBe(3.5);
    expect(ac.position.z).toBeLessThan(1.5);
    expect(ac.position.y + 0.15).toBeCloseTo(WALL_ITEM_TOP); // 0.3 m tall, top at ~1.8 m
    await r.unmount();
  });

  it('walls up raises walls and wall-mounted items', async () => {
    const r = await render(props({}, apartment, CEILING_HEIGHT));
    const walls = objects(r).find((o) => o.name === 'walls')!.instance as Mesh;
    walls.geometry.computeBoundingBox();
    expect(walls.geometry.boundingBox!.max.y).toBeCloseTo(CEILING_HEIGHT);
    const ac = objects(r).find((o) => o.name === 'item:it_3a9c4l')!.instance as Group;
    expect(ac.position.y).toBeGreaterThan(1.4);
    await r.unmount();
  });

  it('shows the selection ring on the selected item only', async () => {
    const r = await render(props({ selectedItemId: 'it_7f3k2a' }));
    const rings = objects(r).filter((o) => o.name === 'ring');
    expect(rings).toHaveLength(1);
    const owner = (rings[0]!.instance as Mesh).parent as Group;
    expect(owner.name).toBe('item:it_7f3k2a');
    await r.unmount();
  });

  it('click on an item selects it; a click on a room floor selects the room under it', async () => {
    const p = props();
    const r = await render(p);
    const item = r.scene.findAll((n) => n.instance.name === 'item:it_7f3k2a')[0]!;
    await r.fireEvent(item, 'click', { delta: 0, stopPropagation: () => {} });
    expect(p.onItem).toHaveBeenCalledWith('it_7f3k2a');
    // A drag that ends on the item is not a click.
    await r.fireEvent(item, 'click', { delta: 40, stopPropagation: () => {} });
    expect(p.onItem).toHaveBeenCalledTimes(1);

    const kitchen = r.scene.findAll((n) => n.instance.name === 'floor:rm_kit')[0]!;
    await r.fireEvent(kitchen, 'click', {
      delta: 0,
      stopPropagation: () => {},
      point: { x: 8.2, y: 0, z: 3.7 },
    });
    expect(p.onRoom).toHaveBeenCalledWith('rm_kit');
    await r.unmount();
  });

  it('dims items that don’t match an active search', async () => {
    const r = await render(props({ matches: new Set(['it_7f3k2a']) }));
    const bodyOf = (id: string) =>
      (objects(r).find((o) => o.name === `item:${id}`)!.instance as Group).getObjectByName(
        'body',
      ) as Mesh;
    const opacity = (id: string) => (bodyOf(id).material as { opacity: number }).opacity;
    expect(opacity('it_7f3k2a')).toBe(1);
    expect(opacity('it_4f8k2q')).toBeLessThan(0.5);
    await r.unmount();
  });

  it('the floor switcher shows only that floor', async () => {
    const r = await render(props({}, basement));
    const names = objects(r).map((o) => o.name);
    expect(names.filter((n) => n.startsWith('item:'))).toEqual(['item:it_9p2x5c']);
    expect(names).toContain('floor-plan:fl_b1');
    await r.unmount();
  });
});
