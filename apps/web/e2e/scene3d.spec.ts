/**
 * The 3D view (milestone 2) in Chromium with SwiftShader WebGL. Tests click exact items through
 * the non-production test hook (window.__housebook, DESIGN 15.15) instead of guessing pixels.
 * The @smoke test also runs against the Docker image, where the hook must not exist.
 */
import type { Page, Request } from '@playwright/test';
import {
  CHEST_FREEZER,
  DISHWASHER,
  FRIDGE,
  expect,
  expectNoA11yViolations,
  floorTab,
  gotoPlan,
  panel,
  planItems,
  searchBox,
  test,
} from './support/fixtures';

/** The part of window.__housebook these tests use (see src/app/testHook.ts). */
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

const SCENE_CHUNK = /\/assets\/Scene3dView-[\w-]+\.js$/;
const MODEL_FILE = /\.(glb|gltf)$/;
const toggle = (page: Page, name: '2D' | '3D') =>
  page.getByRole('group', { name: 'Plan style' }).getByRole('button', { name, exact: true });
const viewport3d = (page: Page) => page.getByRole('region', { name: /^3D view of / });
const canvas = (page: Page) => page.locator('.scene3d canvas');
const banner3d = (page: Page) => page.locator('.banner[data-reason]', { hasText: /3D/ });

// No uncaught errors while the scene mounts, re-renders and unmounts (toggle, floor switch,
// context loss).
const pageErrors = new WeakMap<Page, Error[]>();
test.beforeEach(({ page }) => {
  const errors: Error[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (e) => errors.push(e));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)?.map((e) => e.message) ?? []).toEqual([]);
});

/** Wait until the scene has drawn and the camera has stopped moving. */
async function settled(page: Page) {
  await page.waitForFunction(() => {
    const s = window.__housebook?.scene;
    return !!s && s.frames() > 0 && !s.moving();
  });
}

async function open3d(page: Page, url = '/') {
  await gotoPlan(page, url);
  await toggle(page, '3D').click();
  await expect(canvas(page)).toBeVisible();
  await settled(page);
}

const scene = (page: Page) =>
  page.evaluate(() => {
    const s = window.__housebook!.scene!;
    return { camera: s.camera(), info: s.info(), frames: s.frames() };
  });

async function itemPoint(page: Page, id: string) {
  const p = await page.evaluate((i) => window.__housebook!.scene!.itemToScreen(i), id);
  if (!p) throw new Error(`item ${id} is not in the scene`);
  return p;
}

async function clickItem(page: Page, id: string) {
  const p = await itemPoint(page, id);
  await page.mouse.click(p.x, p.y);
}

async function viewportCentre(page: Page) {
  const b = (await viewport3d(page).boundingBox())!;
  // clientLeft/Top: the 1 px border.
  return { x: b.x + 1 + (b.width - 2) / 2, y: b.y + 1 + (b.height - 2) / 2 };
}

test('2D/3D toggle: 2D by default, three.js loads only when 3D is first opened @smoke', async ({
  page,
}) => {
  const chunks: string[] = [];
  page.on('request', (r: Request) => {
    if (SCENE_CHUNK.test(new URL(r.url()).pathname)) chunks.push(r.url());
  });
  await gotoPlan(page);
  await expect(toggle(page, '2D')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page, '3D')).toHaveAttribute('aria-pressed', 'false');
  await expect(planItems(page)).toHaveCount(13);
  expect(chunks).toEqual([]);

  await toggle(page, '3D').click();
  await expect(canvas(page)).toBeVisible();
  await expect(toggle(page, '3D')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.plan')).toHaveCount(0);
  expect(chunks).toHaveLength(1);
  // The canvas says it isn't the accessible path and points to the ones that are.
  await expect(canvas(page)).toHaveAttribute('role', 'img');
  await expect(canvas(page)).toHaveAttribute('aria-label', /2D plan or the List view/);
  await expect(viewport3d(page)).toHaveAccessibleDescription(/2D plan and the List view/);
  // Room labels are drawn (HTML overlays on the canvas).
  await expect(page.locator('.label3d', { hasText: 'Kitchen' })).toBeVisible();

  await toggle(page, '2D').click();
  await expect(planItems(page)).toHaveCount(13);
  await toggle(page, '3D').click();
  await expect(canvas(page)).toBeVisible();
  await expect(viewport3d(page)).toHaveAttribute('data-ready', 'true'); // first frame drawn
  expect(chunks).toHaveLength(1); // the module is cached, not fetched again

  // The test hook exists only in non-production builds; the Docker image is a production build.
  const hook = await page.evaluate(() => typeof window.__housebook);
  expect(hook).toBe(process.env.E2E_DOCKER ? 'undefined' : 'object');

  // Losing the WebGL context falls back to 2D, with a way back.
  await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.scene3d canvas')!;
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    gl!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(banner3d(page)).toContainText('dropped its graphics context');
  await expect(planItems(page)).toHaveCount(13);
  await expect(toggle(page, '2D')).toHaveAttribute('aria-pressed', 'true');
  await banner3d(page).getByRole('button', { name: 'Reload 3D' }).click();
  await expect(canvas(page)).toBeVisible();
  await expect(viewport3d(page)).toHaveAttribute('data-ready', 'true');
  await expect(banner3d(page)).toHaveCount(0);
});

test('the 2D/3D choice is remembered per browser', async ({ page }) => {
  await open3d(page);
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect(toggle(page, '3D')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('housebook.planStyle'))).toBe('3d');
  await toggle(page, '2D').click();
  await page.reload();
  await expect(planItems(page)).toHaveCount(13);
  await expect(canvas(page)).toHaveCount(0);
});

test('the scene draws the selected floor: walls, every item, demand rendering', async ({
  page,
}) => {
  await open3d(page);
  const { info, frames } = await scene(page);
  expect(info.floorId).toBe('fl_0');
  expect(info.items).toHaveLength(13);
  expect(info.items).not.toContain(CHEST_FREEZER);
  expect(info.wallTriangles).toBeGreaterThan(0);
  expect(info.wallHeight).toBe(0.3); // cut away low: nothing hides behind a wall (M2-03)
  // frameloop="demand": nothing is drawn while nothing changes.
  await page.waitForTimeout(400);
  expect((await scene(page)).frames).toBe(frames);
});

test('clicking an item in 3D opens its details, like the 2D plan', async ({ page }) => {
  await open3d(page);
  const before = (await scene(page)).camera;
  await clickItem(page, DISHWASHER);
  await expect(page).toHaveURL(`/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('heading', { level: 2, name: 'Dishwasher' })).toBeFocused();
  await expect(page.locator('.name3d', { hasText: 'Dishwasher' })).toBeVisible();
  // The camera doesn't jump to an item clicked in the scene (it is already under the pointer).
  await settled(page);
  expect((await scene(page)).camera.angle).toBe(before.angle);

  await clickItem(page, FRIDGE);
  await expect(page).toHaveURL(`/i/${FRIDGE}`);
  await expect(panel(page).getByRole('heading', { level: 2, name: 'Fridge' })).toBeVisible();

  // Esc closes; a click on a room's floor opens the room.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  // The stage widens again and an unmoved camera refits: wait before aiming at a tile.
  await settled(page);
  const tile = await page.evaluate(() => window.__housebook!.scene!.cellToScreen(8, 3));
  await page.mouse.click(tile.x, tile.y);
  await expect(panel(page).getByRole('heading', { name: 'Kitchen' })).toBeVisible();
});

test('a drag pans the camera and does not select', async ({ page }) => {
  await open3d(page);
  const p = await itemPoint(page, DISHWASHER);
  const before = (await scene(page)).camera;
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 80, p.y + 40, { steps: 5 });
  await page.mouse.up();
  // Read positions only once the last pan frame has been drawn (M2-09).
  await settled(page);
  await expect(panel(page)).toBeHidden();
  const after = (await scene(page)).camera;
  expect(after.x).not.toBeCloseTo(before.x, 3);
  // The dishwasher moved with the pointer.
  const q = await itemPoint(page, DISHWASHER);
  expect(q.x - p.x).toBeCloseTo(80, 0);
  expect(q.y - p.y).toBeCloseTo(40, 0);
});

test('search: picking a result centres the camera on the item', async ({ page }) => {
  await open3d(page);
  await searchBox(page).fill('e15');
  await page.getByRole('option', { name: /Dishwasher/ }).click();
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await settled(page);
  const p = await itemPoint(page, DISHWASHER);
  const c = await viewportCentre(page);
  expect(Math.abs(p.x - c.x)).toBeLessThan(2);
  expect(Math.abs(p.y - c.y)).toBeLessThan(2);
  // While searching, the scene keeps showing everything (non-matches are dimmed, not hidden).
  expect((await scene(page)).info.items).toHaveLength(13);
});

test('deep link /i/<id> opens 3D on the item’s floor, centred on it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('housebook.planStyle', '3d'));
  await page.goto(`/i/${CHEST_FREEZER}`);
  await expect(canvas(page)).toBeVisible();
  await expect(panel(page).getByRole('heading', { name: 'Chest freezer' })).toBeVisible();
  await expect(floorTab(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
  await settled(page);
  const { info } = await scene(page);
  expect(info).toMatchObject({ floorId: 'fl_b1', items: [CHEST_FREEZER] });
  const p = await itemPoint(page, CHEST_FREEZER);
  const c = await viewportCentre(page);
  expect(Math.abs(p.x - c.x)).toBeLessThan(2);
  expect(Math.abs(p.y - c.y)).toBeLessThan(2);
});

test('floor switcher shows one floor at a time', async ({ page }) => {
  await open3d(page);
  await floorTab(page, 'Basement').click();
  await expect(viewport3d(page)).toHaveAttribute('data-floor-id', 'fl_b1');
  await settled(page);
  expect((await scene(page)).info.items).toEqual([CHEST_FREEZER]);
  await expect(page.locator('.label3d', { hasText: 'Kitchen' })).toHaveCount(0);
  await clickItem(page, CHEST_FREEZER);
  await expect(panel(page).getByRole('heading', { name: 'Chest freezer' })).toBeVisible();
  await floorTab(page, 'Apartment').click();
  await expect(viewport3d(page)).toHaveAttribute('data-floor-id', 'fl_0');
  await settled(page);
  expect((await scene(page)).info.items).toHaveLength(13);
});

test('rotate in 90° steps with buttons and keys; zoom, fit and walls up', async ({ page }) => {
  await open3d(page);
  const compass = page.locator('.compass');
  await expect(compass).toHaveText(/north/i);

  await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
  await expect(viewport3d(page)).toHaveAttribute('data-heading', 'west');
  await expect(compass).toHaveText(/west/i);
  await settled(page);
  expect((await scene(page)).camera).toMatchObject({ angle: -90, heading: 'west' });
  // Items stay clickable after rotating.
  await clickItem(page, DISHWASHER);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Keyboard: the viewport is focusable; [ and ] rotate, + − zoom, 0 fits.
  await viewport3d(page).focus();
  await page.keyboard.press(']');
  await expect(viewport3d(page)).toHaveAttribute('data-heading', 'south');
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(viewport3d(page)).toHaveAttribute('data-heading', 'north');
  await settled(page);
  const z0 = (await scene(page)).camera.zoom;
  await page.keyboard.press('+');
  await settled(page);
  expect((await scene(page)).camera.zoom).toBeCloseTo(z0 * 1.25, 3);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await settled(page);
  expect((await scene(page)).camera.zoom).toBeCloseTo(z0, 3);
  await page.keyboard.press('ArrowLeft');
  await settled(page);
  await page.keyboard.press('0');
  await settled(page);
  expect((await scene(page)).camera.zoom).toBeCloseTo(z0, 3);

  const wallsUp = page.getByRole('button', { name: 'Walls up' });
  await expect(wallsUp).toHaveAttribute('aria-pressed', 'false');
  await wallsUp.click();
  await expect(wallsUp).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport3d(page)).toHaveAttribute('data-walls', 'up');
  await expect.poll(async () => (await scene(page)).info.wallHeight).toBe(2.5);
});

test('reduced motion: camera moves jump instead of easing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open3d(page);
  const f0 = (await scene(page)).frames;
  await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
  await expect(viewport3d(page)).toHaveAttribute('data-heading', 'west');
  await settled(page);
  const s = await scene(page);
  expect(s.camera.angle).toBe(-90);
  expect(s.frames - f0).toBeLessThanOrEqual(3); // one jump, not a tween

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const f1 = s.frames;
  await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
  await settled(page);
  expect((await scene(page)).frames - f1).toBeGreaterThan(5); // eased over several frames
});

test('without WebGL the 3D option is disabled and explained', async ({ page }) => {
  // A browser with WebGL turned off; 3D was chosen earlier (or on another device).
  await page.addInitScript({
    content: `
      localStorage.setItem('housebook.planStyle', '3d');
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/i.test(type) ? null : original.call(this, type, ...rest);
      };
    `,
  });
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  const three = toggle(page, '3D');
  await expect(three).toHaveAttribute('aria-disabled', 'true');
  await expect(three).toHaveAccessibleDescription(/needs WebGL/);
  await three.click({ force: true }); // aria-disabled: Playwright would wait for it to enable
  await expect(canvas(page)).toHaveCount(0);
  await expect(toggle(page, '2D')).toHaveAttribute('aria-pressed', 'true');
  await expectNoA11yViolations(page);
});

test('the 2D/3D toggle and 3D controls work from the keyboard; axe passes around the canvas', async ({
  page,
}) => {
  await gotoPlan(page);
  await toggle(page, '3D').focus();
  await page.keyboard.press('Enter');
  await expect(canvas(page)).toBeVisible();
  await expect(toggle(page, '3D')).toBeFocused();
  await settled(page);
  // Visible focus on the toggle.
  const outline = await toggle(page, '3D').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Tab');
  await expect(searchBox(page)).toBeFocused();
  await page.getByRole('button', { name: 'Rotate view clockwise' }).focus();
  await page.keyboard.press('Space');
  await expect(viewport3d(page)).toHaveAttribute('data-heading', 'west');
  await expectNoA11yViolations(page);
  await toggle(page, '2D').focus();
  await page.keyboard.press('Space');
  await expect(planItems(page)).toHaveCount(13);
});

/** Colour of the page pixel at `p` (a screenshot, with the DOM overlays hidden). */
async function pixel(page: Page, p: { x: number; y: number }) {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(
    async ({ png, p }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    { png, p },
  );
}

test('M2-03: the water valve behind a wall stays visible, cut away and with walls up', async ({
  page,
}) => {
  // Main water valve (critical) in the Utility room's south row, just inside the exterior
  // wall: with walls up, the walls facing the camera fade so it stays visible.
  const VALVE = 'it_2v9q6t';
  const tint = [0x4f, 0x86, 0xc6]; // models.ts valve tint
  await open3d(page);
  await page.addStyleTag({ content: '.overlay3d { visibility: hidden !important; }' });
  const seen: string[] = [];
  for (const walls of ['cut', 'up'] as const) {
    if (walls === 'up') {
      await page.getByRole('button', { name: 'Walls up' }).click();
      await expect(viewport3d(page)).toHaveAttribute('data-walls', 'up');
    }
    for (const heading of ['north', 'west', 'south', 'east']) {
      await expect(viewport3d(page)).toHaveAttribute('data-heading', heading);
      await settled(page);
      // Looking south the washer stands in front of it: an item, not a wall (see the
      // picking test in scene3d-verify.spec.ts).
      if (heading !== 'south') {
        const px = await pixel(page, await itemPoint(page, VALVE));
        const d = Math.hypot(px[0]! - tint[0]!, px[1]! - tint[1]!, px[2]! - tint[2]!);
        if (d >= 60) seen.push(`${walls} ${heading}: rgb(${px.join(',')})`);
      }
      await page.getByRole('button', { name: 'Rotate view clockwise' }).click();
    }
  }
  expect(seen).toEqual([]);
});

// ---- milestone 3: catalogue models ------------------------------------------------------

const models = (page: Page) => page.evaluate(() => window.__housebook!.scene!.models());

/** Requests for model files, by path. */
function modelRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (MODEL_FILE.test(path)) seen.push(path);
  });
  return seen;
}

test('M3: the first visit fetches no model; 3D loads each model file once', async ({ page }) => {
  const seen = modelRequests(page);
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  expect(seen).toEqual([]);

  await toggle(page, '3D').click();
  await settled(page);
  const m = await models(page);
  expect(Object.keys(m)).toHaveLength(13);
  expect(Object.values(m).every((k) => k === 'glb' || k === 'procedural')).toBe(true);
  expect(m[FRIDGE]).toBe('glb');
  expect(m[DISHWASHER]).toBe('procedural');
  // Content-hashed files, one request per file, however many items share it.
  expect(seen.length).toBeGreaterThan(0);
  expect(new Set(seen).size).toBe(seen.length);
  for (const path of seen) expect(path).toMatch(/^\/assets\/[a-z_]+-[\w-]{8,}\.glb$/);

  // Back to 2D and to 3D again: cached, nothing fetched twice.
  await toggle(page, '2D').click();
  await toggle(page, '3D').click();
  await settled(page);
  expect(new Set(seen).size).toBe(seen.length);
});

test('M3: clicking a model selects its item', async ({ page }) => {
  await open3d(page);
  expect((await models(page))[FRIDGE]).toBe('glb');
  await clickItem(page, FRIDGE);
  await expect(page).toHaveURL(`/i/${FRIDGE}`);
  await expect(panel(page).getByRole('heading', { level: 2, name: 'Fridge' })).toBeVisible();
});

for (const [what, reply, tries] of [
  ['a missing model (404)', { status: 404, body: 'not found' }, 1],
  ['a corrupt model file', { status: 200, body: 'this is not a glb' }, 1],
  ['a server error (retried once)', { status: 503, body: 'busy' }, 2],
] as const) {
  test(`M3: ${what} falls back to the box`, async ({ page }) => {
    let hits = 0;
    await page.route(/\/assets\/fridge-[\w-]+\.glb$/, (route) => {
      hits += 1;
      return route.fulfill({ ...reply, contentType: 'application/octet-stream' });
    });
    await open3d(page);
    const m = await models(page);
    expect(m[FRIDGE]).toBe('box');
    expect(m[DISHWASHER]).toBe('procedural');
    expect(hits).toBe(tries);
    // Still selectable as a box; no retry loop afterwards.
    await clickItem(page, FRIDGE);
    await expect(panel(page).getByRole('heading', { level: 2, name: 'Fridge' })).toBeVisible();
    await page.waitForTimeout(1500);
    expect(hits).toBe(tries);
  });
}

test('M3: model files are content-hashed and served immutable @smoke', async ({ page }) => {
  const replies: { path: string; status: number; cache: string; type: string }[] = [];
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (MODEL_FILE.test(path)) {
      const h = r.headers();
      replies.push({
        path,
        status: r.status(),
        cache: h['cache-control'] ?? '',
        type: h['content-type'] ?? '',
      });
    }
  });
  await gotoPlan(page);
  expect(replies).toEqual([]);
  await toggle(page, '3D').click();
  await expect(viewport3d(page)).toHaveAttribute('data-ready', 'true');
  // The kitchen's fridge is a GLB; wait for it (every type in the house loads in parallel).
  await expect.poll(() => replies.some((r) => r.path.startsWith('/assets/fridge-'))).toBe(true);
  for (const r of replies) {
    expect(r.path).toMatch(/^\/assets\/[a-z_]+-[\w-]{8,}\.glb$/);
    expect(r.status).toBe(200);
    expect(r.cache).toContain('immutable');
    // The slim Python image has no /etc/mime.types, so .glb is octet-stream there (the
    // loader reads bytes either way); model/gltf-binary where the system knows the type.
    expect(['model/gltf-binary', 'application/octet-stream']).toContain(r.type);
  }
});
