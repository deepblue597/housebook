/**
 * Milestone 3 models: every catalogue type has a model, each model fits its item's box, sits
 * at its mount height and faces the way the data contract says (§2.2), and loading is cached,
 * retried at most once and falls back to the box.
 */
import { Box3, type Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import catalogJson from '@contract/catalog.json';
import credits from '../../../assets/models/LICENSES.md?raw';
import { modelSpec, placementSpec } from '../../../catalog/models';
import {
  CEILING_HEIGHT,
  type Mount,
  type Vec3,
  WALL_ITEM_TOP,
  itemTransform,
} from '../../../domain/scene';
import { ensureLoaded, modelState, modelStatus, setSceneLoaderForTests } from './library';
import { GLB_MODELS, type GlbSource, modelSource } from './manifest';
import { type Bounds, fitModel, fittedBounds, yawBounds, yawPoint } from './normalise';
import { PROCEDURAL_TYPES, proceduralModel } from './procedural';
import { type ModelTemplate, templateFromScene } from './template';

// The shipped model files, as data: URLs (Vite inlines them for the test).
const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../../assets/models/*.glb', {
      query: '?inline',
      import: 'default',
      eager: true,
    }),
  ).map(([path, data]) => [path.split('/').pop()!, data]),
);
const CATALOG = catalogJson;
const TS = 1;
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

async function parseGlb(file: string): Promise<Object3D> {
  const data = FILES[file];
  if (!data) throw new Error(`${file} is not shipped`);
  const bin = atob(data.slice(data.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (await new GLTFLoader().parseAsync(bytes.buffer, '')).scene;
}

/** The template every catalogue type is drawn with (the shipped GLBs, parsed). */
async function templateOf(type: string): Promise<ModelTemplate> {
  const src = modelSource(type);
  if (src.kind === 'procedural') return proceduralModel(src.type);
  return templateFromScene(await parseGlb(`${src.type}.glb`), src.yaw);
}

/** The item box for `type` at rotation 0 on tile (2, 3). */
function boxOf(type: string, rotation = 0) {
  const spec = placementSpec(type);
  return { spec, t: itemTransform({ x: 2, y: 3, rotation }, spec, modelSpec(type), TS) };
}

const inside = (b: Bounds, size: Vec3) => {
  const e = 1e-6;
  expect(b.min.x).toBeGreaterThanOrEqual(-size.x / 2 - e);
  expect(b.max.x).toBeLessThanOrEqual(size.x / 2 + e);
  expect(b.min.y).toBeGreaterThanOrEqual(-size.y / 2 - e);
  expect(b.max.y).toBeLessThanOrEqual(size.y / 2 + e);
  expect(b.min.z).toBeGreaterThanOrEqual(-size.z / 2 - e);
  expect(b.max.z).toBeLessThanOrEqual(size.z / 2 + e);
};

describe('yaw', () => {
  it('turns like three.js rotation.y (counter-clockwise from above)', () => {
    const front = { x: 0, y: 0, z: -1 };
    expect(yawPoint(front, 180)).toEqual({ x: -0, y: 0, z: 1 });
    expect(yawPoint({ x: 0, y: 0, z: 1 }, 90)).toEqual({ x: 1, y: 0, z: -0 });
    expect(yawPoint({ x: 0, y: 0, z: 1 }, 270)).toEqual({ x: -1, y: 0, z: 0 });
    const v = new Vector3(0.3, 0.2, -0.7).applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const p = yawPoint({ x: 0.3, y: 0.2, z: -0.7 }, 90);
    close(p.x, v.x);
    close(p.z, v.z);
  });
  it('turns bounds into bounds', () => {
    const b: Bounds = { min: { x: 0, y: 0, z: -2 }, max: { x: 1, y: 3, z: 0 } };
    expect(yawBounds(b, 180)).toEqual({ min: { x: -1, y: 0, z: -0 }, max: { x: -0, y: 3, z: 2 } });
  });
});

describe('fitModel', () => {
  const b: Bounds = { min: { x: -4, y: 0, z: -1 }, max: { x: 0, y: 9, z: 2 } };
  const size = { x: 0.8, y: 1.8, z: 0.8 };
  it.each<Mount>(['floor', 'wall', 'ceiling'])(
    'keeps proportions and fits the box (%s)',
    (mount) => {
      const f = fitModel(b, size, mount);
      const r = fittedBounds(b, f);
      inside(r, size);
      // Uniform scale: the limiting side touches the box.
      close(f.scale, Math.min(0.8 / 4, 1.8 / 9, 0.8 / 3));
      close((r.max.x + r.min.x) / 2, 0);
    },
  );
  it('stands floor items on the bottom, hangs wall and ceiling items from the top', () => {
    close(fittedBounds(b, fitModel(b, size, 'floor')).min.y, -0.9);
    close(fittedBounds(b, fitModel(b, size, 'wall')).max.y, 0.9);
    close(fittedBounds(b, fitModel(b, size, 'ceiling')).max.y, 0.9);
  });
  it('puts a wall item’s back against the wall side of its box', () => {
    close(fittedBounds(b, fitModel(b, size, 'wall')).min.z, -0.4);
    const floor = fittedBounds(b, fitModel(b, size, 'floor'));
    close((floor.min.z + floor.max.z) / 2, 0);
  });
});

describe('catalogue → model', () => {
  it('every catalogue type has a model of its own (GLB or procedural)', () => {
    for (const t of CATALOG.types) {
      const src = modelSource(t.key);
      expect(src.type, t.key).toBe(t.key);
      if (src.kind === 'procedural') expect(PROCEDURAL_TYPES).toContain(t.key);
    }
    expect(modelSource('refrigerator')).toMatchObject({ kind: 'glb', type: 'fridge' });
  });
  it('unknown and missing types get the neutral model', () => {
    expect(modelSource('jacuzzi')).toEqual({ kind: 'procedural', type: 'other' });
    expect(modelSource(null)).toEqual({ kind: 'procedural', type: 'other' });
    expect(proceduralModel('jacuzzi')).toBe(proceduralModel('other'));
  });
  it('ships exactly the GLBs the manifest uses, each credited as CC0', () => {
    const files = Object.keys(FILES).sort();
    expect(files).toEqual(
      Object.keys(GLB_MODELS)
        .map((k) => `${k}.glb`)
        .sort(),
    );
    for (const f of files) expect(credits).toMatch(new RegExp(`\`${f}\`.*CC0`));
  });

  describe.each(CATALOG.types.map((t) => t.key))('%s', (type) => {
    it('fits the item box at its mount height', async () => {
      const tpl = await templateOf(type);
      const { spec, t } = boxOf(type);
      const r = fittedBounds(tpl.bounds, fitModel(tpl.bounds, t.size, spec.mount));
      inside(r, t.size);
      // Inside the footprint (× tileSize), with a sensible real height.
      expect(t.size.x).toBeLessThanOrEqual(spec.footprint[0] * TS);
      expect(t.size.z).toBeLessThanOrEqual(spec.footprint[1] * TS);
      expect(r.max.y - r.min.y).toBeGreaterThan(0.02);
      expect(r.max.y - r.min.y).toBeLessThanOrEqual(2);
      const bottom = t.position.y + r.min.y;
      const top = t.position.y + r.max.y;
      if (spec.mount === 'floor') close(bottom, 0);
      if (spec.mount === 'wall') close(top, WALL_ITEM_TOP);
      if (spec.mount === 'ceiling') close(top, CEILING_HEIGHT);
    });
  });
});

/**
 * Where a model's front points in the world: the parts named as its front (door glass, door,
 * screen…) sit on the +z side of the model after yaw; after the item's rotation that side
 * faces the direction in the data contract's table.
 */
const FRONT_PARTS: Record<string, string[]> = {
  washer: ['glass'],
  microwave: ['glass'],
  oven: ['glass'],
  fridge: ['metal'], // the handles
  dishwasher: ['door', 'panel'],
  boiler: ['panel', 'display'],
  fuse: ['door'],
};
const FACING: Record<number, [number, number]> = {
  0: [0, 1],
  90: [-1, 0],
  180: [0, -1],
  270: [1, 0],
};

describe.each(Object.keys(FRONT_PARTS))('%s faces the contract’s way', (type) => {
  it.each([0, 90, 180, 270])('rotation %i', async (rotation) => {
    const tpl = await templateOf(type);
    const centre = new Box3(
      new Vector3(tpl.bounds.min.x, tpl.bounds.min.y, tpl.bounds.min.z),
      new Vector3(tpl.bounds.max.x, tpl.bounds.max.y, tpl.bounds.max.z),
    ).getCenter(new Vector3());
    const front = new Box3();
    for (const p of tpl.parts.filter((p) => FRONT_PARTS[type]!.includes(p.name))) {
      p.geometry.computeBoundingBox();
      front.union(p.geometry.boundingBox!);
    }
    expect(front.isEmpty()).toBe(false);
    // In the model's frame the front parts lie towards +z…
    const local = front.getCenter(new Vector3()).sub(centre).setY(0);
    expect(local.z).toBeGreaterThan(Math.abs(local.x));
    // …and the item's rotation turns +z to the contract's direction.
    const { t } = boxOf(type, rotation);
    const dir = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), t.rotationY);
    const [ex, ez] = FACING[rotation]!;
    close(dir.x, ex);
    close(dir.z, ez);
  });
});

describe('library', () => {
  afterEach(() => setSceneLoaderForTests(null));
  const fridge = modelSource('fridge') as GlbSource;
  const flush = () => new Promise((r) => setTimeout(r, 5));

  it('loads a type once, however many items use it', async () => {
    const loader = vi.fn(() => parseGlb('fridge.glb'));
    setSceneLoaderForTests(loader);
    expect(modelStatus('fridge')).toBe('loading');
    ensureLoaded(fridge);
    ensureLoaded(fridge);
    await vi.waitFor(() => expect(modelStatus('fridge')).toBe('glb'));
    ensureLoaded(fridge);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(modelState('freezer')).toBe(modelState('fridge'));
  });
  it('a 404 or a broken file falls back to the box with no retry', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('HTTP 404')));
    setSceneLoaderForTests(loader);
    ensureLoaded(fridge);
    await vi.waitFor(() => expect(modelStatus('fridge')).toBe('box'));
    await flush();
    ensureLoaded(fridge);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('a network error or 5xx is retried once, then the box stays', async () => {
    // Retryable errors come from the default fetch loader; drive it through fetch.
    setSceneLoaderForTests(null, 0);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('busy', { status: 503 }));
    ensureLoaded(fridge);
    await vi.waitFor(() => expect(modelStatus('fridge')).toBe('box'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('procedural types are ready at once, with a stable snapshot', () => {
    expect(modelStatus('valve')).toBe('procedural');
    expect(modelState('valve')).toBe(modelState('valve'));
    expect(modelStatus('jacuzzi')).toBe('procedural');
  });
});
