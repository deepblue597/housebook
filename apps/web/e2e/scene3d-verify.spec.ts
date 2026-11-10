/**
 * Independent verification of the 3D view (milestone 2), written by QA against DESIGN §7.4,
 * 15.10, 15.12, 15.15 and data contract §2.2 — not a rerun of scene3d.spec.ts.
 *
 * - Picking ↔ projection: every item is clickable at every heading (the raycast hits the same
 *   item the test hook projects), and floor pixels under each projected tile show that tile's
 *   room colour (catches a mirrored or shifted scene that the hook alone could not).
 * - Contract §2.2 on crafted data: tileSize ≠ 1, footprint overrides rotated by 90/270 (anchor
 *   = min corner after rotation), wall items against the edge their rotation names.
 * - Robustness: chunk load failure + retry, repeated 2D↔3D toggling, rapid floor switching,
 *   resize after a pan, hover, wheel zoom anchoring, console errors.
 * - Phone: tap, drag and pinch on the 3D view.
 *
 * Tests named `M2-xx` were written as failing reproductions of the bugs QA filed; they pass
 * since the fixes. The "retest" section probes the behaviour added with those fixes (D18 walls,
 * 2D footprints, camera limits, reason-based banners, chunk retry, floor kept on refresh).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  CHEST_FREEZER,
  DISHWASHER,
  FRIDGE,
  type HouseJson,
  expect,
  expectNoA11yViolations,
  exampleHouse,
  floorTab,
  gotoPlan,
  panel,
  planView,
  planItems,
  searchBox,
  test,
} from './support/fixtures';

interface SceneHook {
  itemToScreen: (id: string) => { x: number; y: number } | null;
  cellToScreen: (x: number, y: number) => { x: number; y: number };
  camera: () => { x: number; z: number; zoom: number; angle: number; heading: string };
  moving: () => boolean;
  frames: () => number;
  info: () => { items: string[]; wallTriangles: number; floorId: string; wallHeight: number };
  models: () => Record<string, 'loading' | 'glb' | 'procedural' | 'box'>;
}
declare global {
  interface Window {
    __housebook?: { scene: SceneHook | null };
  }
}

const SCENE_CHUNK = '**/assets/Scene3dView-*.js';
const toggle = (page: Page, name: '2D' | '3D') =>
  page.getByRole('group', { name: 'Plan style' }).getByRole('button', { name, exact: true });
const viewport3d = (page: Page) => page.getByRole('region', { name: /^3D view of / });
const canvas = (page: Page) => page.locator('.scene3d canvas');
const banner3d = (page: Page) => page.locator('.banner[data-reason]', { hasText: /3D/ });

// Uncaught errors and console errors/warnings fail every test here (three.js and React both
// report real problems — leaked contexts, unmount races — only on the console).
const problems = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    // SwiftShader performance chatter, not an app problem.
    if (/GL Driver Message/.test(m.text())) return;
    // Tracked separately by the M2-04 test below.
    if (/THREE\.Clock: This module has been deprecated/.test(m.text())) return;
    list.push(`${m.type()}: ${m.text()}`);
  });
});
test.afterEach(({ page }, info) => {
  // Tests that abort requests on purpose expect the network error on the console.
  const expected = info.annotations.find((a) => a.type === 'console')?.description;
  const got = (problems.get(page) ?? []).filter((p) => !expected || !new RegExp(expected).test(p));
  expect(got).toEqual([]);
});

/**
 * Opening or closing the details panel resizes the stage: react-three-fiber resizes its canvas
 * ~50 ms later (debounced measure) and an unmoved camera refits on the next ResizeObserver
 * tick. The hook's moving() sees neither, so wait until camera, viewport and canvas sizes stay
 * the same across that window (see M2-06).
 */
async function stable(page: Page) {
  const snapshot = () =>
    page.evaluate(async () => {
      const snap = () => {
        const el = document.querySelector<HTMLElement>('.scene3d');
        const cv = el?.querySelector('canvas');
        const s = window.__housebook?.scene;
        if (!el || !cv || !s || s.frames() === 0 || s.moving()) return null;
        if (cv.clientWidth !== el.clientWidth || cv.clientHeight !== el.clientHeight) return null;
        return JSON.stringify([s.camera(), el.clientWidth, el.clientHeight]);
      };
      // Quiet for longer than react-three-fiber's 50 ms resize debounce, then two frames.
      const a = snap();
      await new Promise((ok) => setTimeout(ok, 80));
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      return a !== null && a === snap();
    });
  await expect.poll(snapshot, { intervals: [0, 20, 50] }).toBe(true);
}

async function open3d(page: Page, url = '/') {
  await gotoPlan(page, url);
  await toggle(page, '3D').click();
  await expect(canvas(page)).toBeVisible();
  await stable(page);
}

const info = (page: Page) => page.evaluate(() => window.__housebook!.scene!.info());
const camera = (page: Page) => page.evaluate(() => window.__housebook!.scene!.camera());

async function itemPoint(page: Page, id: string) {
  const p = await page.evaluate((i) => window.__housebook!.scene!.itemToScreen(i), id);
  if (!p) throw new Error(`item ${id} is not in the scene`);
  return p;
}
const cellPoint = (page: Page, x: number, y: number) =>
  page.evaluate(([cx, cy]) => window.__housebook!.scene!.cellToScreen(cx!, cy!), [x, y]);

async function viewportCentre(page: Page) {
  const b = (await viewport3d(page).boundingBox())!;
  return { x: b.x + 1 + (b.width - 2) / 2, y: b.y + 1 + (b.height - 2) / 2 };
}

/** Selected item id from the URL (/i/<id>), or null. */
const selectedFromUrl = (page: Page) => {
  const m = /\/i\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  return m ? decodeURIComponent(m[1]!) : null;
};

/** Colours of page pixels (screenshot, so DOM overlays are hidden first). */
async function pixels(page: Page, points: { x: number; y: number }[]) {
  await page.addStyleTag({ content: '.overlay3d { visibility: hidden !important; }' });
  await stable(page);
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(
    async ({ png, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      return points.map((p) => {
        const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
      });
    },
    { png, points },
  );
}

const hex = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
/** palette.ts: a room's 3D floor colour is its colour at 60 % over the light paper. */
const floorColour = (room: string) => {
  const paper = hex('#F9FBFA');
  return hex(room).map((v, i) => Math.round(v * 0.6 + paper[i]! * 0.4)) as [number, number, number];
};
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

// ---------------------------------------------------------------------------------------------
// Picking and projection agree with what is drawn
// ---------------------------------------------------------------------------------------------

test('every item is clickable at every 90° heading, and the click selects that item', async ({
  page,
}) => {
  await open3d(page);
  const ids = (await info(page)).items;
  expect(ids).toHaveLength(13);
  const misses: string[] = [];
  for (const heading of ['north', 'west', 'south', 'east']) {
    await expect(viewport3d(page)).toHaveAttribute('data-heading', heading);
    await stable(page);
    for (const id of ids) {
      const p = await itemPoint(page, id);
      await page.mouse.click(p.x, p.y);
      const opened = await panel(page)
        .waitFor({ timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      const got = opened
        ? (selectedFromUrl(page) ??
          `room ${await panel(page).getByRole('heading', { level: 2 }).textContent()}`)
        : 'nothing';
      if (got !== id) misses.push(`${heading}: clicked ${id}, got ${got}`);
      if (opened) {
        await page.keyboard.press('Escape');
        await expect(panel(page)).toBeHidden();
        await stable(page);
      }
    }
    await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
  }
  // A tall item in front of a low one hides it at some headings; the click then (correctly)
  // hits the item in front. These two are occlusions, not picking errors:
  expect(misses).toEqual([
    'south: clicked it_2v9q6t, got it_0k5s2m', // valve behind the washer, looking south
    'east: clicked it_9b3m7x, got it_4f8k2q', // oven behind the fridge, looking east
  ]);
});

test('room floors are drawn where the contract puts them (pixel colour under each tile)', async ({
  page,
}) => {
  const house = exampleHouse();
  const floor = house.floors.find((f) => f.id === 'fl_0')!;
  const color = new Map(house.rooms.map((r) => [r.id, r.color]));
  const itemsAt = new Set(
    house.placements.filter((p) => p.floorId === 'fl_0').map((p) => `${p.x},${p.y}`),
  );
  await open3d(page);
  // Toward the camera at heading north is +y (south). A tile is unobstructed when it and the
  // two tiles in front of it belong to the same room (no wall) and no item stands nearby.
  const free = Object.entries(floor.cells)
    .map(([k, room]) => {
      const [x, y] = k.split(',').map(Number) as [number, number];
      return { x, y, room };
    })
    .filter(
      ({ x, y, room }) =>
        floor.cells[`${x},${y + 1}`] === room &&
        floor.cells[`${x},${y + 2}`] === room &&
        [-1, 0, 1].every((dx) => [0, 1, 2].every((dy) => !itemsAt.has(`${x + dx},${y + dy}`))),
    );
  const rooms = new Set(free.map((c) => c.room));
  expect(rooms.size).toBeGreaterThanOrEqual(4); // Living room, Kitchen, Bedroom, Balcony…
  const points = await Promise.all(free.map((c) => cellPoint(page, c.x, c.y)));
  const seen = await pixels(page, points);
  const wrong = free.flatMap((c, i) => {
    const px = seen[i]!;
    const want = floorColour(color.get(c.room)!);
    const nearest = [...color].sort(
      (a, b) => dist(px, floorColour(a[1])) - dist(px, floorColour(b[1])),
    )[0]![0];
    return nearest === c.room && dist(px, want) < 12
      ? []
      : [`(${c.x},${c.y}) ${c.room}: got rgb(${px.join(',')}), nearest ${nearest}`];
  });
  expect(wrong).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Data contract §2.2 on crafted data
// ---------------------------------------------------------------------------------------------

/**
 * tileSize 0.5, one 10×8 room on the ground floor and one on a basement floor. Item ids come
 * from examples/house (their notes exist); only the placements change.
 */
const OVEN = 'it_9b3m7x';
const TV = 'it_5t1v8n'; // tv: wall
const HEATER = 'it_1w7e3h'; // heater: wall
const AC_BED = 'it_6h4j9b'; // ac: wall
const AC_LIV = 'it_3a9c4l'; // ac: wall
const SMOKE = 'it_4g6y1r'; // smoke: ceiling

function craftedHouse(): HouseJson & { schemaVersion: number } {
  const cells = (w: number, d: number, room: string) =>
    Object.fromEntries(
      Array.from({ length: w * d }, (_, i) => [`${i % w},${Math.floor(i / w)}`, room]),
    );
  return {
    schemaVersion: 1,
    grid: { tileSize: 0.5, width: 12, depth: 10 },
    rooms: [
      { id: 'rm_a', name: 'Studio', color: '#6BA7D6' },
      { id: 'rm_c', name: 'Cellar', color: '#D9785B' },
    ],
    floors: [
      { id: 'fl_0', name: 'Ground', level: 0, cells: cells(10, 8, 'rm_a') },
      { id: 'fl_b1', name: 'Cellar', level: -1, cells: cells(4, 4, 'rm_c') },
    ],
    placements: [
      // Footprint overrides, rotated: anchor is the min corner after rotation, 90/270 swap.
      { itemId: FRIDGE, floorId: 'fl_0', x: 2, y: 2, rotation: 90, footprint: [2, 1] },
      { itemId: OVEN, floorId: 'fl_0', x: 5, y: 1, rotation: 0, footprint: [2, 1] },
      { itemId: DISHWASHER, floorId: 'fl_0', x: 4, y: 4, rotation: 270, footprint: [1, 3] },
      // Wall items, one per back edge.
      { itemId: AC_BED, floorId: 'fl_0', x: 8, y: 0, rotation: 0 }, // back north
      { itemId: HEATER, floorId: 'fl_0', x: 9, y: 4, rotation: 90 }, // back east
      { itemId: AC_LIV, floorId: 'fl_0', x: 8, y: 7, rotation: 180 }, // back south
      { itemId: TV, floorId: 'fl_0', x: 0, y: 4, rotation: 270 }, // back west
      { itemId: SMOKE, floorId: 'fl_0', x: 8, y: 3, rotation: 0 },
      { itemId: CHEST_FREEZER, floorId: 'fl_b1', x: 1, y: 1, rotation: 180 },
    ] as unknown as HouseJson['placements'],
    openings: [],
  };
}

test.describe('contract §2.2 on a crafted house (tileSize 0.5, footprint overrides)', () => {
  test('rotated multi-tile footprints occupy exactly the tiles the contract names', async ({
    page,
    backend,
  }) => {
    const { url } = await backend({ house: craftedHouse() });
    await open3d(page, `${url}/`);
    expect((await info(page)).items).toHaveLength(8);
    // fridge [2,1] at 90 → 1×2 at (2,2): tiles (2,2) and (2,3); oven [2,1] at 0 → (5,1),(6,1);
    // dishwasher [1,3] at 270 → 3×1 at (4,4): tiles (4,4),(5,4),(6,4).
    const occupied: [string, number, number][] = [
      [FRIDGE, 2, 2],
      [FRIDGE, 2, 3],
      [OVEN, 5, 1],
      [OVEN, 6, 1],
      [DISHWASHER, 4, 4],
      [DISHWASHER, 5, 4],
      [DISHWASHER, 6, 4],
    ];
    const got: string[] = [];
    for (const [, x, y] of occupied) {
      const p = await cellPoint(page, x, y);
      await page.mouse.click(p.x, p.y);
      await expect(panel(page)).toBeVisible();
      got.push(`${x},${y} → ${selectedFromUrl(page) ?? 'room'}`);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      await stable(page);
    }
    expect(got).toEqual(occupied.map(([id, x, y]) => `${x},${y} → ${id}`));

    // The tile in front of (south of) each footprint is floor, not the item: no spill-over
    // from an unswapped footprint.
    for (const [x, y] of [
      [3, 2], // east of the rotated fridge: it is 1 wide after rotation
      [7, 1], // east of the oven
      [7, 4], // east of the dishwasher
      [4, 5], // south of the dishwasher: it is 1 deep after rotation
    ] as const) {
      const p = await cellPoint(page, x, y);
      await page.mouse.click(p.x, p.y);
      await expect(panel(page).getByRole('heading', { name: 'Studio' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      await stable(page);
    }
  });

  test('wall items hang on the edge their rotation names (0 N, 90 E, 180 S, 270 W)', async ({
    page,
    backend,
  }) => {
    const { url } = await backend({ house: craftedHouse() });
    await open3d(page, `${url}/`);
    const wall: [string, number, number, 'n' | 'e' | 's' | 'w'][] = [
      [AC_BED, 8, 0, 'n'],
      [HEATER, 9, 4, 'e'],
      [AC_LIV, 8, 7, 's'],
      [TV, 0, 4, 'w'],
    ];
    // Screen x is unaffected by height, so compare it with the tile centre's. Looking north,
    // east is screen right; looking east (angle 90), south is screen right.
    const offsets = async () =>
      Promise.all(
        wall.map(async ([id, x, y]) => {
          const it = await itemPoint(page, id);
          const c = await cellPoint(page, x, y);
          return (it.x - c.x) / (await camera(page)).zoom; // metres along screen right
        }),
      );
    const north = await offsets(); // screen right = east
    // (At tileSize 0.5 the shift is small: half a tile minus the wall gap and half the depth.)
    expect(north[1]).toBeGreaterThan(0.01); // heater: back east
    expect(north[3]).toBeLessThan(-0.01); // TV: back west
    expect(Math.abs(north[0]!)).toBeLessThan(0.01); // AC north: no east-west shift
    // Turn to look east (two counter-clockwise steps from north go west → south → east? no:
    // counter-clockwise once from north looks east).
    await page.getByRole('button', { name: 'Rotate view counter-clockwise' }).click();
    await expect(viewport3d(page)).toHaveAttribute('data-heading', 'east');
    await stable(page);
    const east = await offsets(); // screen right = south
    expect(east[0]).toBeLessThan(-0.01); // AC (back north) is north of its tile centre
    expect(east[2]).toBeGreaterThan(0.01); // AC (back south) is south of its tile centre
    // …and every wall item stays inside its own tile (0.25 m from centre at tileSize 0.5).
    for (const v of [...north, ...east]) expect(Math.abs(v)).toBeLessThan(0.25);

    // All of them, and the ceiling item, are clickable where the hook says they are.
    for (const id of [AC_BED, HEATER, AC_LIV, TV, SMOKE]) {
      const p = await itemPoint(page, id);
      await page.mouse.click(p.x, p.y);
      await expect.poll(() => selectedFromUrl(page)).toBe(id);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      await stable(page);
    }
  });

  test('basement item on a tileSize 0.5 house: deep link opens its floor, centred', async ({
    page,
    backend,
  }) => {
    const { url } = await backend({ house: craftedHouse() });
    await page.addInitScript(() => localStorage.setItem('housebook.planStyle', '3d'));
    await page.goto(`${url}/i/${CHEST_FREEZER}`);
    await expect(canvas(page)).toBeVisible();
    await stable(page);
    expect((await info(page)).floorId).toBe('fl_b1');
    const p = await itemPoint(page, CHEST_FREEZER);
    const c = await viewportCentre(page);
    expect(Math.abs(p.x - c.x)).toBeLessThan(2);
    expect(Math.abs(p.y - c.y)).toBeLessThan(2);
    // Clicking the tile it stands on (rotation 180 doesn't move a 1×1 anchor) selects it.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await stable(page);
    const t = await cellPoint(page, 1, 1);
    await page.mouse.click(t.x, t.y);
    await expect.poll(() => selectedFromUrl(page)).toBe(CHEST_FREEZER);
  });
});

// ---------------------------------------------------------------------------------------------
// Lazy loading and failure paths
// ---------------------------------------------------------------------------------------------

test('three.js is not fetched for 2D, list, search or details use', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (/Scene3dView|three|fiber|drei/i.test(r.url())) fetched.push(r.url());
  });
  await gotoPlan(page);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await searchBox(page).fill('dish');
  await page.getByRole('option', { name: /Dishwasher/ }).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await toggle(page, '2D').click();
  await expect(planItems(page)).toHaveCount(13);
  await page.waitForLoadState('networkidle');
  expect(fetched).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Robustness: toggling, floors, resize
// ---------------------------------------------------------------------------------------------

test('toggling 2D↔3D twenty times leaks no WebGL contexts and logs nothing', async ({ page }) => {
  await open3d(page);
  for (let i = 0; i < 20; i++) {
    await toggle(page, '2D').click();
    await expect(planItems(page)).toHaveCount(13);
    await toggle(page, '3D').click();
    await expect(viewport3d(page)).toHaveAttribute('data-ready', 'true');
  }
  await stable(page);
  // Still a working scene (Chrome drops the oldest context past 16 live ones).
  await expect(banner3d(page)).toHaveCount(0);
  const p = await itemPoint(page, DISHWASHER);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => selectedFromUrl(page)).toBe(DISHWASHER);
});

test('rapid floor switching ends on the last floor chosen', async ({ page }) => {
  await open3d(page);
  for (let i = 0; i < 6; i++) {
    await floorTab(page, 'Basement').click();
    await floorTab(page, 'Apartment').click();
  }
  await floorTab(page, 'Basement').click();
  await expect(viewport3d(page)).toHaveAttribute('data-floor-id', 'fl_b1');
  await stable(page);
  expect((await info(page)).items).toEqual([CHEST_FREEZER]);
  const p = await itemPoint(page, CHEST_FREEZER);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => selectedFromUrl(page)).toBe(CHEST_FREEZER);
});

test('after a pan and a window resize, clicks and overlays still line up', async ({ page }) => {
  await open3d(page);
  const v = (await viewport3d(page).boundingBox())!;
  const start = { x: v.x + v.width / 2, y: v.y + v.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 60, start.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
  await stable(page);
  await page.setViewportSize({ width: 900, height: 640 });
  await stable(page);
  for (const id of [FRIDGE, DISHWASHER]) {
    const p = await itemPoint(page, id);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => selectedFromUrl(page)).toBe(id);
    // The panel opening narrows the stage; once settled, the name overlay sits right above
    // the item it names.
    await stable(page);
    const q = await itemPoint(page, id);
    const name = page.locator('.name3d');
    await expect(name).toBeVisible();
    const b = (await name.boundingBox())!;
    expect(Math.abs(b.x + b.width / 2 - q.x)).toBeLessThan(3);
    expect(b.y + b.height / 2).toBeLessThan(q.y);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await stable(page);
  }
});

test('hover shows the item name and a pointer cursor; leaving clears both', async ({ page }) => {
  await open3d(page);
  const p = await itemPoint(page, FRIDGE);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('.name3d', { hasText: 'Fridge' })).toBeVisible();
  await expect(viewport3d(page)).toHaveCSS('cursor', 'pointer');
  const v = (await viewport3d(page).boundingBox())!;
  await page.mouse.move(v.x + 5, v.y + 5);
  await expect(page.locator('.name3d')).toHaveCount(0);
  await expect(viewport3d(page)).not.toHaveCSS('cursor', 'pointer');
});

test('wheel zoom keeps the item under the pointer in place', async ({ page }) => {
  await open3d(page);
  const p = await itemPoint(page, DISHWASHER);
  const z0 = (await camera(page)).zoom;
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -200);
  await stable(page);
  expect((await camera(page)).zoom).toBeGreaterThan(z0 * 1.2);
  // The dishwasher's ground point stays under the pointer; its model centre (above the
  // floor) moves only by its height, so compare horizontally.
  const q = await itemPoint(page, DISHWASHER);
  expect(Math.abs(q.x - p.x)).toBeLessThan(2);
});

test('a selection made in 2D survives the switch to 3D and is centred there', async ({ page }) => {
  await gotoPlan(page);
  await page.locator(`.plan [data-item-id="${FRIDGE}"]`).click();
  await expect(panel(page).getByRole('heading', { name: 'Fridge' })).toBeVisible();
  await toggle(page, '3D').click();
  await expect(canvas(page)).toBeVisible();
  await stable(page);
  await expect(panel(page).getByRole('heading', { name: 'Fridge' })).toBeVisible();
  const p = await itemPoint(page, FRIDGE);
  const c = await viewportCentre(page);
  expect(Math.abs(p.x - c.x)).toBeLessThan(2);
  expect(Math.abs(p.y - c.y)).toBeLessThan(2);
  await toggle(page, '2D').click();
  await expect(page.locator(`.plan [data-item-id="${FRIDGE}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('status badges in 3D match the 2D plan, item for item and level for level', async ({
  page,
}) => {
  // A day on which the example house has overdue, due-soon and warranty-ending items.
  await page.clock.setFixedTime(new Date('2027-04-26T10:00:00+03:00'));
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  // 2D: circle = overdue, diamond (path) = due soon, square (rect) = warranty ending.
  const twoD = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.plan [data-item-id]')].flatMap((g) => {
        const m = g.querySelector('.mark');
        if (!m) return [];
        const level =
          m.tagName === 'g' ? 'overdue' : m.tagName === 'path' ? 'due_soon' : 'warranty_ending';
        return [[g.getAttribute('data-item-id')!, level]];
      }),
    ),
  );
  expect(Object.keys(twoD).length).toBeGreaterThan(0);
  await toggle(page, '3D').click();
  await stable(page);
  const threeD = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.overlay3d [data-anchor^="badge:"]')].map((el) => {
        const glyph = el.textContent;
        const level =
          glyph === '!'
            ? 'overdue'
            : glyph === '◆'
              ? 'due_soon'
              : glyph === '■'
                ? 'warranty_ending'
                : glyph;
        return [el.getAttribute('data-anchor')!.slice('badge:'.length), level];
      }),
    ),
  );
  expect(threeD).toEqual(twoD);
});

test('search dims non-matching items in 3D (pixels change), matches keep their colour', async ({
  page,
}) => {
  await open3d(page);
  // Sample where each model covers its own tile (M3: a light-coloured model's centre can sit
  // over the light background, where a dimmed model barely differs; its floor tile doesn't).
  const placed = exampleHouse() as HouseJson & {
    placements: { itemId: string; x: number; y: number }[];
  };
  const at = async () => {
    const pts = [];
    for (const id of [FRIDGE, DISHWASHER]) {
      const pl = placed.placements.find((q) => q.itemId === id)!;
      pts.push(await cellPoint(page, pl.x, pl.y));
    }
    return pixels(page, pts);
  };
  const before = await at();
  await searchBox(page).fill('e15'); // matches the dishwasher only
  await expect(page.getByRole('option', { name: /Dishwasher/ })).toBeVisible();
  await stable(page);
  const after = await at();
  expect(dist(before[0]!, after[0]!), 'fridge is dimmed').toBeGreaterThan(20);
  expect(dist(before[1]!, after[1]!), 'dishwasher is not').toBeLessThan(6);
});

test('a house.json change on disk moves the item in 3D without a reload', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await open3d(page, `${url}/`);
  const house = exampleHouse() as HouseJson & { placements: { x: number; y: number }[] };
  const fridge = house.placements.find((p) => p.itemId === FRIDGE)!;
  fridge.x = 12; // into the Bedroom
  fridge.y = 2;
  writeFileSync(join(dataDir, 'house.json'), JSON.stringify(house, null, 2));
  // Revalidation runs on focus (store/data.ts revalidateOnFocus).
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await stable(page);
        const t = await cellPoint(page, 12, 2);
        const it = await itemPoint(page, FRIDGE);
        return Math.abs(it.x - t.x) < 2;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const t = await cellPoint(page, 12, 2);
  await page.mouse.click(t.x, t.y);
  await expect.poll(() => selectedFromUrl(page)).toBe(FRIDGE);
});

test('switching the theme while in 3D redraws the scene without errors', async ({ page }) => {
  await open3d(page);
  const f0 = await page.evaluate(() => window.__housebook!.scene!.frames());
  const theme = page.getByRole('button', { name: /^Theme: / });
  for (let i = 0; i < 3; i++) await theme.click();
  await stable(page);
  expect(await page.evaluate(() => window.__housebook!.scene!.frames())).toBeGreaterThan(f0);
  await expect(canvas(page)).toBeVisible();
});

test('Esc closes the details from the 3D viewport and focus stays usable', async ({ page }) => {
  await open3d(page);
  const p = await itemPoint(page, DISHWASHER);
  await page.mouse.click(p.x, p.y);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeFocused();
  await viewport3d(page).focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  // Nothing in the canvas can take focus; the viewport (or the 3D toggle) is a sensible home.
  await expect(page.locator('body')).not.toBeFocused();
});

test('an unknown deep link in 3D shows the not-found panel over a working scene', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('housebook.planStyle', '3d'));
  await page.goto('/i/it_nope00');
  await expect(canvas(page)).toBeVisible();
  await stable(page);
  await expect(panel(page)).toContainText(/not found|doesn.t exist|no item/i);
  expect((await info(page)).items).toHaveLength(13);
});

test('axe passes in 3D with the details panel open and with the context-loss banner', async ({
  page,
}, info) => {
  info.annotations.push({
    type: 'console',
    description: 'WEBGL_lose_context extension not supported',
  });
  await open3d(page);
  const p = await itemPoint(page, DISHWASHER);
  await page.mouse.click(p.x, p.y);
  await expect(panel(page)).toBeVisible();
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.scene3d canvas')!;
    (c.getContext('webgl2') ?? c.getContext('webgl'))!
      .getExtension('WEBGL_lose_context')!
      .loseContext();
  });
  await expect(banner3d(page)).toBeVisible();
  await expectNoA11yViolations(page);
});

test('M2-07 (FE-09 robustness): an invalid house.json whose error mentions “unreadable” is still “invalid”', async ({
  page,
  backend,
}) => {
  // A typo'd/unknown key is rejected (additionalProperties: false) and the API message names
  // the key: "house.json is invalid: unreadableNote: Extra inputs are not permitted; …".
  const house = { ...exampleHouse(), schemaVersion: 1, unreadableNote: 'see wiki' };
  const { url } = await backend({ house });
  await gotoPlan(page, `${url}/`).catch(() => page.goto(`${url}/`));
  const banner = page.locator('.banner[role="note"]');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-reason', 'invalid');
  await expect(banner).not.toContainText('permissions');
});

// ---------------------------------------------------------------------------------------------
// Bugs filed by QA (M2-xx): reproductions, passing since the fixes
// ---------------------------------------------------------------------------------------------

/** Lose the WebGL context the way iOS does under memory pressure. */
const loseContext = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.scene3d canvas')!;
    (c.getContext('webgl2') ?? c.getContext('webgl'))!
      .getExtension('WEBGL_lose_context')!
      .loseContext();
  });

test('M2-01: an item clicked twice in 3D is never centred again from search/list', async ({
  page,
}) => {
  await open3d(page);
  // Click the dishwasher, then click it again while it is selected.
  for (let i = 0; i < 2; i++) {
    const p = await itemPoint(page, DISHWASHER);
    await page.mouse.click(p.x, p.y);
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Dishwasher');
    await stable(page);
  }
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await stable(page);
  // Search for it and pick it: the camera centres a search result (DESIGN; scene3d.spec.ts
  // "search: picking a result centres the camera on the item") — but not this one.
  await searchBox(page).fill('e15');
  await page.getByRole('option', { name: /Dishwasher/ }).click();
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await stable(page);
  const p = await itemPoint(page, DISHWASHER);
  const c = await viewportCentre(page);
  expect(Math.abs(p.x - c.x)).toBeLessThan(2);
  expect(Math.abs(p.y - c.y)).toBeLessThan(2);
});

test('M2-02: focus is dropped to <body> when the 3D view falls back after a context loss', async ({
  page,
}, info) => {
  // R3F's own unmount calls loseContext on the already-lost context.
  info.annotations.push({
    type: 'console',
    description: 'WEBGL_lose_context extension not supported',
  });
  await open3d(page);
  await page.getByRole('button', { name: 'Rotate view clockwise' }).focus();
  await loseContext(page);
  await expect(banner3d(page)).toBeVisible();
  // Keyboard and screen-reader users lose their place; focus should land somewhere useful
  // (the "Reload 3D" button or the 2D plan), not on <body>.
  await expect(page.locator('body')).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
});

test('M2-03: an item in a room’s south row is hidden behind the 1 m cut-away wall', async ({
  page,
}) => {
  // Main water valve (critical, DESIGN 15.11) at (14,8): the southern row of the Utility room,
  // behind the exterior south wall when looking north (the default view).
  const VALVE = 'it_2v9q6t';
  await open3d(page);
  const p = await itemPoint(page, VALVE);
  const [px] = await pixels(page, [p]);
  // models.ts: valve tint #4f86c6 (Lambert-lit, allow shading); the wall in front is grey.
  expect(dist(px!, hex('#4f86c6')), `pixel rgb(${px!.join(',')})`).toBeLessThan(60);
});

test('M2-04: opening 3D logs no deprecation warnings (THREE.Clock)', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && /THREE\./.test(m.text())) warnings.push(m.text());
  });
  await open3d(page);
  expect(warnings).toEqual([]);
});

test.describe('M2-05: a failed 3D chunk load', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    info.annotations.push({
      type: 'console',
      description: 'Failed to load resource|3D view failed|dynamically imported module',
    });
  });

  test('falls back to 2D with "Try 3D again" — not an endless import loop', async ({ page }) => {
    let attempts = 0;
    await page.route(SCENE_CHUNK, (route) => {
      attempts += 1;
      return route.abort('internetdisconnected');
    });
    await gotoPlan(page);
    await toggle(page, '3D').click();
    // Today: the stage stays on "Loading the 3D view…" while the browser re-requests the
    // chunk ~1,000 times a second (offline, or a stale tab after a new deploy → 404).
    await expect(banner3d(page)).toContainText('Couldn’t load the 3D view');
    await expect(planItems(page)).toHaveCount(13);
    expect(attempts).toBeLessThanOrEqual(2);

    await page.unroute(SCENE_CHUNK);
    await banner3d(page).getByRole('button', { name: 'Try 3D again' }).click();
    await expect(canvas(page)).toBeVisible();
    await stable(page);
    await expect(banner3d(page)).toHaveCount(0);
  });

  test('the import is not retried in a loop (request count stays bounded)', async ({ page }) => {
    let attempts = 0;
    await page.route(SCENE_CHUNK, (route) => {
      attempts += 1;
      return route.fulfill({ status: 404, body: 'gone after a redeploy' });
    });
    await gotoPlan(page);
    await toggle(page, '3D').click();
    // Wait for the first request, then give a loop a moment to show itself.
    await expect.poll(() => attempts).toBeGreaterThan(0);
    await page.evaluate(() => new Promise((ok) => setTimeout(ok, 300)));
    expect(attempts).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Retest of the M2 fixes and decisions (D18 and the coordinator's list)
// ---------------------------------------------------------------------------------------------

const HEADINGS = ['north', 'west', 'south', 'east'] as const; // order of clockwise turns
/** Unit step from a tile towards the camera, per heading (+y is south). */
const TOWARD_CAMERA = { north: [0, 1], west: [1, 0], south: [0, -1], east: [-1, 0] } as const;

/**
 * Tiles of `floorId` that nothing but walls could hide at `heading`: no item on or next to the
 * tile, and none up to three tiles towards the camera (a 1.8 m fridge hides 1.8 m behind it).
 * An open door leaf (D37) covers the tile it swings into; with walls up (`tallDoors`, 2.1 m) it
 * hides like an item standing there.
 */
function openTiles(
  house: HouseJson,
  floorId: string,
  heading: (typeof HEADINGS)[number],
  tallDoors: boolean,
) {
  const floor = house.floors.find((f) => f.id === floorId)!;
  const items = new Set(
    house.placements.filter((p) => p.floorId === floorId).map((p) => `${p.x},${p.y}`),
  );
  const doors = new Set<string>();
  for (const o of house.openings ?? []) {
    if (o.floorId !== floorId || o.kind !== 'door') continue;
    // As doorSwingsIntoKeyedTile: the keyed tile if it is in a room, else the other one.
    const other = o.side === 'n' ? `${o.x},${o.y - 1}` : `${o.x - 1},${o.y}`;
    const swing =
      `${o.x},${o.y}` in floor.cells || !(other in floor.cells) ? `${o.x},${o.y}` : other;
    (tallDoors ? items : doors).add(swing);
  }
  const [dx, dy] = TOWARD_CAMERA[heading];
  return Object.entries(floor.cells).flatMap(([k, room]) => {
    const [x, y] = k.split(',').map(Number) as [number, number];
    if (doors.has(k)) return [];
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) if (items.has(`${x + a},${y + b}`)) return [];
    for (let t = 1; t <= 3; t++)
      for (let l = -1; l <= 1; l++) {
        const [ax, ay] = dx === 0 ? [x + l, y + dy * t] : [x + dx * t, y + l];
        if (items.has(`${ax},${ay}`)) return [];
      }
    return [{ x, y, room }];
  });
}

/** Tiles whose pixel isn't (close to) their own room's floor colour. */
async function hiddenTiles(
  page: Page,
  house: HouseJson,
  floorId: string,
  maxDist: number,
  /** Also require the pixel to be nearest to its own room among all rooms' colours. */
  nearestRoom = true,
) {
  const heading = (await camera(page)).heading as (typeof HEADINGS)[number];
  const walls = await viewport3d(page).getAttribute('data-walls');
  const tiles = openTiles(house, floorId, heading, walls === 'up');
  const colour = new Map(house.rooms.map((r) => [r.id, r.color]));
  const seen = await pixels(page, await Promise.all(tiles.map((t) => cellPoint(page, t.x, t.y))));
  return {
    count: tiles.length,
    hidden: tiles.flatMap((t, i) => {
      const px = seen[i]!;
      const d = dist(px, floorColour(colour.get(t.room)!));
      const nearest = [...colour].sort(
        (a, b) => dist(px, floorColour(a[1])) - dist(px, floorColour(b[1])),
      )[0]![0];
      return d < maxDist && (!nearestRoom || nearest === t.room)
        ? []
        : [`${heading} (${t.x},${t.y}) ${t.room}: rgb(${px.join(',')}) Δ${Math.round(d)}`];
    }),
  };
}

test.describe('retest: walls (D18)', () => {
  test('cut-away walls hide no room tile at any heading', async ({ page }) => {
    const house = exampleHouse();
    await open3d(page);
    const hidden: string[] = [];
    for (const h of HEADINGS) {
      await expect(viewport3d(page)).toHaveAttribute('data-heading', h);
      await stable(page);
      const r = await hiddenTiles(page, house, 'fl_0', 12);
      expect(r.count, h).toBeGreaterThan(20);
      hidden.push(...r.hidden);
      await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
    }
    expect(hidden).toEqual([]);
  });

  test('walls up: every room tile stays visible through the faded walls, at all four headings, after rotating and switching floors', async ({
    page,
  }) => {
    const house = exampleHouse();
    await open3d(page);
    await page.getByRole('button', { name: 'Walls up' }).click();
    await expect(viewport3d(page)).toHaveAttribute('data-walls', 'up');
    const hidden: string[] = [];
    const sweep = async (floorId: string) => {
      for (const h of HEADINGS) {
        await expect(viewport3d(page)).toHaveAttribute('data-heading', h);
        await stable(page);
        // Seen through one or two 20 % walls, a tile's colour shifts (up to ~36 % wall); it is
        // hidden only when it reads as wall. Nearest-room is not required: Living room and
        // Storage, Kitchen and Hallway are close once tinted.
        const r = await hiddenTiles(page, house, floorId, 40, false);
        hidden.push(...r.hidden.map((x) => `${floorId} ${x}`));
        await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
      }
    };
    await sweep('fl_0');
    // Switch floors with the view turned (fading is per heading and per floor).
    await page.getByRole('button', { name: 'Rotate view clockwise' }).click(); // → west
    await floorTab(page, 'Basement').click();
    await expect(viewport3d(page)).toHaveAttribute('data-floor-id', 'fl_b1');
    await page.getByRole('button', { name: 'Rotate view counter-clockwise' }).click(); // → north
    await sweep('fl_b1');
    await floorTab(page, 'Apartment').click();
    await expect(viewport3d(page)).toHaveAttribute('data-floor-id', 'fl_0');
    await sweep('fl_0');
    expect(hidden).toEqual([]);
  });

  test('walls up: the main water valve (south row, behind the near exterior wall) is visible', async ({
    page,
  }) => {
    await open3d(page);
    await page.getByRole('button', { name: 'Walls up' }).click();
    await stable(page);
    const [px] = await pixels(page, [await itemPoint(page, 'it_2v9q6t')]);
    // Seen through the 20 % wall: still much closer to the valve's blue than to the wall.
    expect(dist(px!, hex('#4f86c6')), `rgb(${px!.join(',')})`).toBeLessThan(70);
  });

  test('wall, ceiling and floor items keep their place when walls go up (no jump)', async ({
    page,
  }) => {
    await open3d(page);
    await viewport3d(page).focus();
    await page.keyboard.press('+'); // the user moved: no refit when the walls change
    await stable(page);
    const ids = ['it_5t1v8n', 'it_4g6y1r', FRIDGE]; // TV (wall), smoke (ceiling), fridge
    const at = () => Promise.all(ids.map((id) => itemPoint(page, id)));
    const before = await at();
    await page.getByRole('button', { name: 'Walls up' }).click();
    await expect.poll(async () => (await info(page)).wallHeight).toBe(2.5);
    await stable(page);
    const after = await at();
    after.forEach((p, i) => {
      expect(Math.abs(p.x - before[i]!.x), ids[i]).toBeLessThan(0.5);
      expect(Math.abs(p.y - before[i]!.y), ids[i]).toBeLessThan(0.5);
    });
  });
});

test.describe('retest: multi-tile footprints in 2D match 3D', () => {
  test('the 2D plan covers exactly the occupied tiles, centred like the 3D model', async ({
    page,
    backend,
  }) => {
    const { url } = await backend({ house: craftedHouse() });
    await gotoPlan(page, `${url}/`);
    const S = 40; // plan units per tile (plan2d/geometry.ts)
    // The plan fits itself after mount and on every stage resize (panel open/close): read the
    // transform fresh once it has stopped changing.
    const view = async () => {
      let last = '';
      await expect
        .poll(async () => {
          const now = JSON.stringify(await planView(page));
          const same = now === last;
          last = now;
          return same && (JSON.parse(now) as { k: number }).k !== 1;
        })
        .toBe(true);
      return JSON.parse(last) as { tx: number; ty: number; k: number };
    };
    const tile = async (x: number, y: number) => {
      const svg = (await page.locator('svg.plan').boundingBox())!;
      const v = await view();
      return {
        x: svg.x + v.tx + v.k * S * (x + 0.5),
        y: svg.y + v.ty + v.k * S * (y + 0.5),
        k: v.k,
      };
    };
    const occupied: [string, number, number][] = [
      [FRIDGE, 2, 2],
      [FRIDGE, 2, 3],
      [OVEN, 5, 1],
      [OVEN, 6, 1],
      [DISHWASHER, 4, 4],
      [DISHWASHER, 5, 4],
      [DISHWASHER, 6, 4],
    ];
    const got: string[] = [];
    for (const [, x, y] of occupied) {
      // Off the centre badge, so the click lands on the footprint itself.
      const p = await tile(x, y);
      await page.mouse.click(p.x + p.k * S * 0.35, p.y + p.k * S * 0.35);
      await expect(panel(page)).toBeVisible();
      got.push(`${x},${y} → ${selectedFromUrl(page) ?? 'room'}`);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
    }
    expect(got).toEqual(occupied.map(([id, x, y]) => `${x},${y} → ${id}`));
    // Outline size and badge centre per item: rect after rotation (w × h tiles).
    for (const [id, x, y, w, h] of [
      [FRIDGE, 2, 2, 1, 2],
      [OVEN, 5, 1, 2, 1],
      [DISHWASHER, 4, 4, 3, 1],
    ] as const) {
      const c = await tile(x + (w - 1) / 2, y + (h - 1) / 2);
      const fp = (await page.locator(`.plan [data-item-id="${id}"] rect.fp`).boundingBox())!;
      expect(fp.width / (c.k * S), id).toBeCloseTo(w, 1);
      expect(fp.height / (c.k * S), id).toBeCloseTo(h, 1);
      expect(Math.abs(fp.x + fp.width / 2 - c.x), id).toBeLessThan(1);
      expect(Math.abs(fp.y + fp.height / 2 - c.y), id).toBeLessThan(1);
    }
  });
});

test.describe('retest: very large and very small grids', () => {
  const corners = (w: number, d: number): [number, number][] => [
    [0, 0],
    [w - 1, 0],
    [0, d - 1],
    [w - 1, d - 1],
  ];
  const grid = (tileSize: number, w: number, d: number, painted: [number, number][]) => ({
    schemaVersion: 1,
    grid: { tileSize, width: w, depth: d },
    rooms: [{ id: 'rm_a', name: 'Plot', color: '#6BA7D6' }],
    floors: [
      {
        id: 'fl_0',
        name: 'Ground',
        level: 0,
        cells: Object.fromEntries(painted.map(([x, y]) => [`${x},${y}`, 'rm_a'])),
      },
    ],
    placements: [
      { itemId: FRIDGE, floorId: 'fl_0', x: w - 1, y: d - 1, rotation: 0 },
      { itemId: DISHWASHER, floorId: 'fl_0', x: 0, y: 0, rotation: 0 },
    ],
    openings: [],
  });

  for (const [name, ts, w, d] of [
    ['5 km (512 × 512 tiles of 10 m)', 10, 512, 512],
    ['2 m (40 × 40 tiles of 5 cm)', 0.05, 40, 40],
  ] as const) {
    test(`${name}: fit shows every corner, unclipped; far items are reachable and clickable`, async ({
      page,
      backend,
    }) => {
      const painted = [
        ...corners(w, d),
        ...corners(w, d).map(([x, y]): [number, number] => [x === 0 ? 1 : x - 1, y]),
      ];
      const { url } = await backend({ house: grid(ts, w, d, painted) });
      await open3d(page, `${url}/`);
      const vb = (await viewport3d(page).boundingBox())!;
      const pts = await Promise.all(corners(w, d).map(([x, y]) => cellPoint(page, x, y)));
      for (const p of pts) {
        expect(p.x).toBeGreaterThan(vb.x);
        expect(p.x).toBeLessThan(vb.x + vb.width);
        expect(p.y).toBeGreaterThan(vb.y);
        expect(p.y).toBeLessThan(vb.y + vb.height);
      }
      // Zoom in on each corner item via search (focus), then it is drawn and clickable there.
      for (const [id, q] of [
        [FRIDGE, /Fridge/],
        [DISHWASHER, /Dishwasher/],
      ] as const) {
        await searchBox(page).fill(id === FRIDGE ? 'fridge' : 'dishwasher');
        await page.getByRole('option', { name: q }).first().click();
        await expect.poll(() => selectedFromUrl(page)).toBe(id);
        await stable(page);
        await page.keyboard.press('Escape');
        await expect(panel(page)).toBeHidden();
        await stable(page);
        const p = await itemPoint(page, id);
        const [px] = await pixels(page, [p]);
        expect(dist(px!, floorColour('#6BA7D6')), `${id} drawn, not clipped`).toBeGreaterThan(10);
        await page.mouse.click(p.x, p.y);
        await expect.poll(() => selectedFromUrl(page)).toBe(id);
        await page.keyboard.press('Escape');
        await expect(panel(page)).toBeHidden();
        await stable(page);
      }
      // Zoom all the way in and out: no clipping errors, the camera stays usable.
      await viewport3d(page).focus();
      for (let i = 0; i < 40; i++) await page.keyboard.press('+');
      await stable(page);
      for (let i = 0; i < 80; i++) await page.keyboard.press('-');
      await stable(page);
      await page.keyboard.press('0');
      await stable(page);
      const again = await Promise.all(corners(w, d).map(([x, y]) => cellPoint(page, x, y)));
      for (const p of again) expect(p.x).toBeGreaterThan(vb.x);
    });
  }
});

test.describe('retest: chunk load retry', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    info.annotations.push({
      type: 'console',
      description: 'Failed to load resource|3D view failed|dynamically imported module',
    });
  });

  test('each retry is one request; the toggle retries too; it recovers once the server is back', async ({
    page,
  }) => {
    let attempts = 0;
    let down = true;
    await page.route(SCENE_CHUNK, (route) => {
      attempts += 1;
      return down ? route.fulfill({ status: 503, body: 'down' }) : route.continue();
    });
    await gotoPlan(page);
    await toggle(page, '3D').click();
    await expect(banner3d(page)).toContainText('Couldn’t load the 3D view');
    await expect(planItems(page)).toHaveCount(13);
    expect(attempts).toBe(1);
    // Still down: "Try 3D again" → one more request, same banner, plan still there.
    await banner3d(page).getByRole('button', { name: 'Try 3D again' }).click();
    await expect.poll(() => attempts).toBe(2);
    await expect(banner3d(page)).toContainText('Couldn’t load the 3D view');
    await expect(planItems(page)).toHaveCount(13);
    // 2D, then the 3D toggle: also a retry (one request).
    await toggle(page, '2D').click();
    await toggle(page, '3D').click();
    await expect.poll(() => attempts).toBe(3);
    await expect(banner3d(page)).toBeVisible();
    await page.evaluate(() => new Promise((ok) => setTimeout(ok, 300)));
    expect(attempts).toBe(3); // nothing in the background
    // Server back: the toggle loads it.
    down = false;
    await toggle(page, '3D').click();
    await expect(canvas(page)).toBeVisible();
    await stable(page);
    await expect(banner3d(page)).toHaveCount(0);
    expect(attempts).toBe(4);
    // Loaded once: later toggles reuse the module.
    await toggle(page, '2D').click();
    await toggle(page, '3D').click();
    await expect(canvas(page)).toBeVisible();
    expect(attempts).toBe(4);
  });
});

test.describe('retest: focus after a context loss', () => {
  test('focus moves to "Reload 3D" with nothing logged; Enter brings 3D back', async ({ page }) => {
    await open3d(page);
    await viewport3d(page).focus();
    await loseContext(page);
    const reload = banner3d(page).getByRole('button', { name: 'Reload 3D' });
    await expect(reload).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(canvas(page)).toBeVisible();
    await stable(page);
  });

  test('a context loss does not steal focus from the search box', async ({ page }) => {
    await open3d(page);
    await searchBox(page).focus();
    await loseContext(page);
    await expect(banner3d(page)).toBeVisible();
    await expect(searchBox(page)).toBeFocused();
  });
});

test.describe('retest: the selected item’s floor is not forced back on refresh', () => {
  for (const style of ['2d', '3d'] as const) {
    test(`${style}: browsing Basement while the dishwasher is open survives a data refresh`, async ({
      page,
      backend,
    }) => {
      const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
      await page.addInitScript((s) => localStorage.setItem('housebook.planStyle', s), style);
      await page.goto(`${url}/i/${DISHWASHER}`);
      await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
      await expect(floorTab(page, 'Apartment')).toHaveAttribute('aria-pressed', 'true');
      await floorTab(page, 'Basement').click();
      await expect(floorTab(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
      // A real change on disk, so the refresh brings a new model.
      const house = exampleHouse();
      house.rooms.find((r) => r.id === 'rm_kit')!.color = '#123456';
      writeFileSync(join(dataDir, 'house.json'), JSON.stringify(house, null, 2));
      await expect
        .poll(
          async () => {
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            return page.evaluate(
              () =>
                (
                  window as unknown as {
                    __housebook: {
                      data: {
                        getState: () => {
                          model: { rooms: Map<string, { color: string }> } | null;
                        };
                      };
                    };
                  }
                ).__housebook.data
                  .getState()
                  .model?.rooms.get('rm_kit')?.color,
            );
          },
          { timeout: 10_000 },
        )
        .toMatch(/^#123456$/i);
      await expect(floorTab(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
      await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
      // Picking the item again (a new selection) does show its floor.
      await searchBox(page).fill('e15');
      await page.getByRole('option', { name: /Dishwasher/ }).click();
      await expect(floorTab(page, 'Apartment')).toHaveAttribute('aria-pressed', 'true');
    });
  }
});

test.describe('retest: read-only banners by reason, end to end', () => {
  const valid = () => ({ ...exampleHouse(), schemaVersion: 1 });
  const cases: [string, unknown, string, RegExp][] = [
    ['not_json', '{"schemaVersion": 1, "grid": ', 'not_json', /not valid JSON/],
    ['bad_version (string)', { ...valid(), schemaVersion: '1' }, 'bad_version', /schemaVersion/],
    [
      'bad_version (missing)',
      (({ schemaVersion: _, ...h }) => h)(valid()),
      'bad_version',
      /schemaVersion/,
    ],
    ['newer_version', { ...valid(), schemaVersion: 99 }, 'newer_version', /newer Housebook/],
    [
      'newer_version, not displayable',
      { ...valid(), schemaVersion: 99, grid: 'big' },
      'newer_version',
      /newer Housebook/,
    ],
    ['invalid (unknown key)', { ...valid(), unreadableNote: 'x' }, 'invalid', /is not valid,/],
    [
      'invalid (key named schemaVersion inside a room)',
      {
        ...valid(),
        rooms: [
          { ...exampleHouse().rooms[0]!, schemaVersion: 1 },
          ...exampleHouse().rooms.slice(1),
        ],
      },
      'invalid',
      /is not valid,/,
    ],
  ];
  for (const [name, house, reason, text] of cases) {
    test(`${name} → data-reason="${reason}"`, async ({ page, backend }) => {
      const { url } = await backend({ house });
      await page.goto(`${url}/`);
      const banner = page.locator('.banner[role="note"]');
      // Each case boots its own backend; give the first snapshot time under a loaded CI box.
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute('data-reason', reason);
      await expect(banner).toContainText(text);
    });
  }

  test('unreadable (permissions, at runtime) → data-reason="unreadable"', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
    await gotoPlan(page, `${url}/`);
    const file = join(dataDir, 'house.json');
    chmodSync(file, 0o000);
    try {
      const banner = page.locator('.banner[role="note"]');
      await expect
        .poll(
          async () => {
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            return (await banner.count()) ? banner.getAttribute('data-reason') : null;
          },
          { timeout: 10_000 },
        )
        .toBe('unreadable');
      await expect(banner).toContainText('can’t be read');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test('M2-08: larger than 16 MiB → "too_large", without blaming permissions', async ({
    page,
    backend,
  }) => {
    const padded = JSON.stringify(valid()).replace(/}$/, `${' '.repeat(17 * 1024 * 1024)}}`);
    const { url } = await backend({ house: padded });
    await page.goto(`${url}/`);
    const banner = page.locator('.banner[role="note"]');
    await expect(banner).toHaveAttribute('data-reason', 'too_large', { timeout: 15_000 });
    await expect(banner).toContainText('larger than 16 MiB');
    // The owner can't fix a size problem by changing permissions.
    await expect(banner).not.toContainText('permissions');
  });
});

test('retest: a burst of wheel zooming is announced once, with the final zoom', async ({
  page,
}) => {
  await open3d(page);
  const live = page.locator('.zoom .sr-only[aria-live]');
  await live.evaluate((el) => {
    const w = window as unknown as { zoomSaid: string[] };
    w.zoomSaid = [];
    new MutationObserver(() => w.zoomSaid.push(el.textContent ?? '')).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const v = (await viewport3d(page).boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -40);
  await stable(page);
  const zoom = Math.round((await camera(page)).zoom);
  await expect(live).toHaveText(`Zoom ${zoom} pixels per metre`);
  const said = await page.evaluate(() => (window as unknown as { zoomSaid: string[] }).zoomSaid);
  expect(said.filter((t) => t).length).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------------------------

test.describe('3D on a phone @phone', () => {
  async function touch(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    return (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
  }

  test('tap opens the bottom sheet; one-finger drag pans; pinch zooms; no page scroll', async ({
    page,
  }) => {
    await open3d(page);
    const p = await itemPoint(page, DISHWASHER);
    await page.touchscreen.tap(p.x, p.y);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close details' }).tap();
    await expect(panel(page)).toBeHidden();
    await stable(page);

    const send = await touch(page);
    const v = (await viewport3d(page).boundingBox())!;
    const c = { x: v.x + v.width / 2, y: v.y + v.height / 2 };
    const before = await itemPoint(page, DISHWASHER);
    await send('touchStart', [c]);
    for (let i = 1; i <= 5; i++) await send('touchMove', [{ x: c.x + 8 * i, y: c.y + 4 * i }]);
    await send('touchEnd', []);
    // Poll: the hook's moving() can't see a camera update React hasn't rendered yet.
    await expect
      .poll(async () => (await itemPoint(page, DISHWASHER)).x - before.x)
      .toBeCloseTo(40, 0);
    const after = await itemPoint(page, DISHWASHER);
    expect(after.y - before.y).toBeCloseTo(20, 0);
    await expect(panel(page)).toBeHidden(); // a drag is not a tap

    const z0 = (await camera(page)).zoom;
    await send('touchStart', [
      { x: c.x - 40, y: c.y },
      { x: c.x + 40, y: c.y },
    ]);
    for (let i = 1; i <= 5; i++)
      await send('touchMove', [
        { x: c.x - 40 - 8 * i, y: c.y },
        { x: c.x + 40 + 8 * i, y: c.y },
      ]);
    await send('touchEnd', []);
    await expect.poll(async () => (await camera(page)).zoom / z0).toBeCloseTo(2, 1);
    const scroll = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(scroll.sw).toBeLessThanOrEqual(scroll.cw);
  });

  test('3D controls fit a phone: no horizontal scroll, 44 px targets', async ({ page }) => {
    await open3d(page);
    const { sw, cw } = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(sw).toBeLessThanOrEqual(cw);
    for (const name of [
      'Rotate view counter-clockwise',
      'Rotate view clockwise',
      'Zoom in',
      'Zoom out',
      'Fit',
      'Walls up',
    ]) {
      const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b, name).not.toBeNull();
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(44);
      expect(b.x + b.width, `${name} inside the screen`).toBeLessThanOrEqual(cw);
    }
  });

  test('without WebGL, a tap on 3D shows the reason on the page (touch has no tooltips)', async ({
    page,
  }) => {
    await page.addInitScript({
      content: `
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          return /webgl/i.test(type) ? null : original.call(this, type, ...rest);
        };
      `,
    });
    await gotoPlan(page);
    const three = toggle(page, '3D');
    await expect(three).toHaveAttribute('aria-disabled', 'true');
    await three.tap({ force: true });
    const why = page.locator('.banner[data-reason="no_webgl"]');
    await expect(why).toBeVisible();
    await expect(why).toContainText('needs WebGL');
    await expect(why).toBeInViewport();
    await expect(canvas(page)).toHaveCount(0);
    await expect(planItems(page)).toHaveCount(13);
  });
});
