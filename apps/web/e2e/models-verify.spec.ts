/**
 * QA verification of milestone 3 (real models) in a real browser: what is fetched and when,
 * and how GLB failures (404, corrupt, 5xx, network, stalled) degrade. Unit tests cover the
 * fitting maths and the loader with a fake fetch; this checks the wiring end to end.
 */
import type { Page, Route } from '@playwright/test';
import { expect, floorTab, gotoPlan, test } from './support/fixtures';

const GLB = '**/assets/*.glb';
const typeOf = (url: string) => /\/assets\/([a-z]+)-[\w-]+\.glb$/.exec(new URL(url).pathname)?.[1];

const ID = {
  fridge: 'it_4f8k2q',
  oven: 'it_9b3m7x',
  washer: 'it_0k5s2m',
  microwave: 'it_2c6p1d',
  tv: 'it_5t1v8n',
} as const;

interface Hook {
  moving: () => boolean;
  itemToScreen: (id: string) => { x: number; y: number } | null;
  /** Keyed by item id. */
  models: () => Record<string, 'loading' | 'glb' | 'procedural' | 'box'>;
}
const hook = <T>(page: Page, fn: string) =>
  page.evaluate<T>(
    `(window.__housebook && window.__housebook.scene) ? window.__housebook.scene.${fn} : null`,
  );

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (e) => list.push(e.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

/** Model status per catalogue type (via the item of that type). */
const models = async (page: Page) => {
  const byId = (await hook<ReturnType<Hook['models']>>(page, 'models()')) ?? {};
  return Object.fromEntries(Object.entries(ID).map(([t, id]) => [t, byId[id]]));
};
const open3d = async (page: Page) => {
  await page.getByRole('group', { name: 'Plan style' }).getByRole('button', { name: '3D' }).click();
  await expect(page.locator('.scene3d')).toHaveAttribute('data-ready', 'true');
};

test('no model is fetched before 3D opens; then one request per GLB type on the floor', async ({
  page,
}) => {
  const got: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.glb')) got.push(typeOf(r.url()) ?? r.url());
  });
  await gotoPlan(page);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.waitForLoadState('networkidle');
  expect(got).toEqual([]);
  await open3d(page);
  // Apartment: fridge, oven, washer, microwave, tv (no dryer in the example house).
  await expect.poll(async () => Object.values(await models(page)).includes('loading')).toBe(false);
  expect(got.sort()).toEqual(['fridge', 'microwave', 'oven', 'tv', 'washer']);
  const m = await models(page);
  for (const t of ['fridge', 'oven', 'washer', 'microwave', 'tv']) expect(m[t], t).toBe('glb');
  // Basement's chest freezer is a fridge: no second fetch; toggling 2D↔3D refetches nothing.
  await floorTab(page, 'Basement').click();
  await page.getByRole('group', { name: 'Plan style' }).getByRole('button', { name: '2D' }).click();
  await open3d(page);
  await page.waitForLoadState('networkidle');
  expect(got).toHaveLength(5);
});

const failures: [string, (route: Route) => Promise<void>, number][] = [
  ['404', (r) => r.fulfill({ status: 404, body: 'nope' }), 1],
  ['corrupt 200', (r) => r.fulfill({ status: 200, body: 'glTF-but-not-really' }), 1],
  [
    'HTML 200 (auth proxy login page)',
    (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>login</html>' }),
    1,
  ],
  ['503', (r) => r.fulfill({ status: 503, body: 'down' }), 2],
  ['network error', (r) => r.abort('connectionreset'), 2],
];
for (const [name, respond, expected] of failures) {
  test(`fridge model ${name} → box, ${expected} request(s), no retry loop, no errors`, async ({
    page,
  }) => {
    let n = 0;
    await page.route(GLB, (route) => {
      if (typeOf(route.request().url()) !== 'fridge') return route.continue();
      n += 1;
      return respond(route);
    });
    await gotoPlan(page);
    await open3d(page);
    await expect.poll(async () => (await models(page)).fridge, { timeout: 10_000 }).toBe('box');
    await page.evaluate(() => new Promise((ok) => setTimeout(ok, 1500))); // > the retry delay
    expect(n).toBe(expected);
    expect((await models(page)).oven).toBe('glb'); // other types unaffected
    // The box is still a working item.
    await expect.poll(() => hook<boolean>(page, 'moving()')).toBe(false);
  });
}

test('a stalled model request draws the box meanwhile and does not hold the scene', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => (release = ok));
  await page.route(GLB, async (route) => {
    if (typeOf(route.request().url()) !== 'fridge') return route.continue();
    await gate;
    return route.continue();
  });
  await gotoPlan(page);
  await open3d(page);
  await expect.poll(async () => (await models(page)).oven).toBe('glb');
  expect((await models(page)).fridge).toBe('loading');
  // Meanwhile the fridge is drawn as its box and works: a click opens it.
  const p = await hook<{ x: number; y: number }>(page, `itemToScreen('${ID.fridge}')`);
  await page.mouse.click(p.x, p.y);
  await expect(page).toHaveURL(/\/i\/it_4f8k2q$/);
  release();
  await expect.poll(async () => (await models(page)).fridge).toBe('glb');
});

test('GLBs are served as hashed, immutable, binary glTF', async ({ page, request }) => {
  const urls: string[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.glb')) urls.push(r.url());
  });
  await gotoPlan(page);
  await open3d(page);
  await expect.poll(() => urls.length).toBeGreaterThan(0);
  const res = await request.get(urls[0]!);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toMatch(/immutable/);
  expect(res.headers()['content-type']).toBe('model/gltf-binary');
});
