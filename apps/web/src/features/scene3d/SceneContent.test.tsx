/**
 * Scene-graph tests (DESIGN 15.15): the 3D scene for examples/house rendered with
 * @react-three/test-renderer, no GPU. Walls are one merged mesh, rooms one mesh each, items
 * sit where the layout says, selection shows, clicks select.
 */
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CEILING_HEIGHT, CUT_HEIGHT, WALL_ITEM_TOP, boxesMesh } from '../../domain/scene';
import { buildModel } from '../../store/model';
import { exampleSnapshot } from '../../test/exampleHouse';
import { sceneLayout } from './layout';
import { setSceneLoaderForTests } from './models/library';
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

/** Models: GLB loads never finish unless a test says otherwise (no network in unit tests). */
beforeEach(() => setSceneLoaderForTests(() => new Promise<Object3D>(() => {})));
afterEach(() => setSceneLoaderForTests(null));

/** A stand-in glTF scene: one mesh. */
function fakeGltf(): Object3D {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(4, 9, 3), new MeshStandardMaterial({ name: 'metal' })));
  return root;
}

const modelOf = (r: Awaited<ReturnType<typeof render>>, id: string) =>
  (objects(r).find((o) => o.name === `item:${id}`)!.instance as Group).getObjectByName('model')!;

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
    // Dishwasher (procedural model) matches; the fridge (still loading: box) and valve don't.
    const r = await render(props({ matches: new Set(['it_7f3k2a']) }));
    const opacities = (id: string) => {
      const out: number[] = [];
      modelOf(r, id).traverse((o) => {
        if (o instanceof Mesh && o.name !== 'front' && o.name !== 'depth')
          out.push((o.material as { opacity: number }).opacity);
      });
      return out;
    };
    expect(opacities('it_7f3k2a').every((o) => o === 1)).toBe(true);
    expect(Math.max(...opacities('it_4f8k2q'))).toBeLessThan(0.5);
    expect(Math.max(...opacities('it_2v9q6t'))).toBeLessThan(0.5);
    // A dimmed model draws its depth first, so its inner parts don't stack up (opaque ghost).
    expect(modelOf(r, 'it_2v9q6t').getObjectByName('depth')).toBeTruthy();
    expect(modelOf(r, 'it_7f3k2a').getObjectByName('depth')).toBeUndefined();
    await r.unmount();
  });

  it('draws catalogue models: procedural at once, GLB once loaded, the box while loading', async () => {
    const r = await render(props());
    expect(modelOf(r, 'it_7f3k2a').userData.kind).toBe('procedural'); // dishwasher
    expect(modelOf(r, 'it_2v9q6t').userData.kind).toBe('procedural'); // valve
    expect(modelOf(r, 'it_4f8k2q').userData.kind).toBe('box'); // fridge, loading
    await r.unmount();

    setSceneLoaderForTests(() => Promise.resolve(fakeGltf()));
    const r2 = await render(props());
    await vi.waitFor(() => expect(modelOf(r2, 'it_4f8k2q').userData.kind).toBe('glb'));
    // Fitted into the item box: uniform scale, standing on the floor of the box.
    const m = modelOf(r2, 'it_4f8k2q');
    expect(m.scale.x).toBeCloseTo(m.scale.y, 9);
    expect(m.scale.x).toBeGreaterThan(0);
    await r2.unmount();
  });

  it('a model that fails to load is drawn as the box', async () => {
    setSceneLoaderForTests(() => Promise.reject(new Error('HTTP 404')));
    const r = await render(props());
    await new Promise((res) => setTimeout(res, 10));
    expect(modelOf(r, 'it_4f8k2q').userData.kind).toBe('box');
    expect(modelOf(r, 'it_4f8k2q').getObjectByName('body')).toBeTruthy();
    await r.unmount();
  });

  it('selection outlines the model’s large parts, hover too', async () => {
    const r = await render(props({ selectedItemId: 'it_7f3k2a', hoverId: 'it_2v9q6t' }));
    const outlined = (id: string) => {
      let n = 0;
      modelOf(r, id).traverse((o) => {
        if (o.parent instanceof Mesh && o.type !== 'Mesh' && o !== modelOf(r, id)) n++;
      });
      return n;
    };
    expect(outlined('it_7f3k2a')).toBeGreaterThan(0);
    expect(outlined('it_2v9q6t')).toBeGreaterThan(0);
    expect(outlined('it_9b3m7x')).toBe(0);
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
