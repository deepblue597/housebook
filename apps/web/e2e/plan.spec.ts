/**
 * The SVG plan: every floor of examples/house, wall geometry against the domain function and an
 * independent edge count, openings, and zoom / pan / fit with mouse, wheel, keyboard and touch.
 */
import type { Page } from '@playwright/test';
import { cellKey } from '../src/domain/coords';
import { floorCells, walls } from '../src/domain/plan';
import {
  DISHWASHER,
  exampleHouse,
  expect,
  floorTab,
  gotoPlan,
  item,
  panel,
  planItems,
  planView,
  test,
} from './support/fixtures';

const S = 40; // plan units per tile (PlanSvg)
const house = exampleHouse();
const grid = { width: house.grid.width, depth: house.grid.depth };
const roomIds = new Set(house.rooms.map((r) => r.id));
const roomName = (id: string) => house.rooms.find((r) => r.id === id)!.name;

/** Rendered wall path → segments in tile units, sorted for comparison. */
function parsePath(d: string | null) {
  return [...(d ?? '').matchAll(/M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)/g)]
    .map((m) => m.slice(1).map((v) => Number(v) / S))
    .map(([x1, y1, x2, y2]) => `${x1},${y1}-${x2},${y2}`)
    .sort();
}

const lengthOf = (segs: string[]) =>
  segs
    .map((s) => s.split(/[-,]/).map(Number))
    .reduce((sum, [x1, y1, x2, y2]) => sum + Math.abs(x2! - x1!) + Math.abs(y2! - y1!), 0);

/** Independent oracle: unit edges between a room tile and empty (exterior) or another room. */
function unitEdges(cells: ReadonlyMap<string, string>) {
  let exterior = 0;
  let interior = 0;
  for (const [key, room] of cells) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = cells.get(cellKey(x + dx, y + dy));
      if (n === undefined) exterior++;
      else if (n !== room) interior += 0.5; // seen from both sides
    }
  }
  return { exterior, interior };
}

for (const floor of [...house.floors].sort((a, b) => b.level - a.level)) {
  test(`floor "${floor.name}" renders its rooms, items, walls and openings @smoke`, async ({
    page,
  }) => {
    await gotoPlan(page);
    await floorTab(page, floor.name).click();
    await expect(floorTab(page, floor.name)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.plan')).toHaveAttribute('aria-label', `${floor.name} plan`);

    // Rooms: one label per room with tiles on this floor, with its area in m².
    const cells = floorCells(floor.cells, grid, roomIds);
    const tilesPerRoom = new Map<string, number>();
    for (const r of cells.values()) tilesPerRoom.set(r, (tilesPerRoom.get(r) ?? 0) + 1);
    const t2 = house.grid.tileSize ** 2;
    const expectedLabels = [...tilesPerRoom].map(([id, n]) => `${roomName(id)} ${n * t2} m²`);
    const labels = page.locator('.plan .rlabel');
    await expect(labels).toHaveCount(expectedLabels.length);
    expect(
      (await labels.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()).sort(),
    ).toEqual(expectedLabels.sort());

    // Items: exactly the placements on this floor.
    const expectedItems = house.placements
      .filter((p) => p.floorId === floor.id)
      .map((p) => p.itemId);
    await expect(planItems(page)).toHaveCount(expectedItems.length);
    const ids = await planItems(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-item-id')),
    );
    expect(ids.sort()).toEqual(expectedItems.sort());
    // Each badge sits on its tile.
    for (const p of house.placements.filter((pl) => pl.floorId === floor.id)) {
      await expect(item(page, p.itemId)).toHaveAttribute(
        'transform',
        `translate(${p.x * S + S / 2},${p.y * S + S / 2})`,
      );
    }

    // Walls: same segments as the domain function, and the same total length as a naive count.
    const expected = walls(cells);
    const toKeys = (segs: typeof expected.interior) =>
      segs.map((s) => `${s.x1},${s.y1}-${s.x2},${s.y2}`).sort();
    const ex = parsePath(await page.locator('.plan path.wall-ex').getAttribute('d'));
    const inn = parsePath(await page.locator('.plan path.wall-in').getAttribute('d'));
    expect(ex).toEqual(toKeys(expected.exterior));
    expect(inn).toEqual(toKeys(expected.interior));
    const oracle = unitEdges(cells);
    expect(lengthOf(ex)).toBe(oracle.exterior);
    expect(lengthOf(inn)).toBe(oracle.interior);
    expect(ex.length).toBeGreaterThan(0);

    // Openings from house.json.
    const openings = (house.openings ?? []).filter((o) => o.floorId === floor.id);
    await expect(page.locator('.plan .door')).toHaveCount(
      openings.filter((o) => o.kind === 'door').length,
    );
    await expect(page.locator('.plan .window')).toHaveCount(
      openings.filter((o) => o.kind === 'window').length,
    );

    // Title block: floor name, total area, item count.
    const total = [...tilesPerRoom.values()].reduce((a, b) => a + b, 0) * t2;
    await expect(page.locator('.plan .title-block')).toContainText(floor.name.toUpperCase());
    await expect(page.locator('.plan .title-block')).toContainText(
      `${total} m² · ${expectedItems.length} items`,
    );
  });
}

test('status marks use a different shape per level, never colour alone', async ({ page }) => {
  await gotoPlan(page);
  // Whatever today is, every badge with a mark must name its status in its accessible name.
  const badges = planItems(page);
  const n = await badges.count();
  for (let i = 0; i < n; i++) {
    const b = badges.nth(i);
    const label = (await b.getAttribute('aria-label')) ?? '';
    const shape = /Check overdue/.test(label)
      ? 'g.mark.bad'
      : /Check due soon/.test(label)
        ? 'path.mark.warn'
        : /Warranty ending/.test(label)
          ? 'rect.mark.warn'
          : null;
    await expect(b.locator('.mark'), label).toHaveCount(shape ? 1 : 0);
    if (shape) await expect(b.locator(shape), label).toHaveCount(1);
  }
});

// ---- zoom, pan, fit ------------------------------------------------------------------

async function viewportBox(page: Page) {
  const box = await page.locator('.viewport').boundingBox();
  if (!box) throw new Error('no viewport');
  return box;
}

test('zoom buttons, keyboard zoom and Fit', async ({ page }) => {
  await gotoPlan(page);
  await expect.poll(async () => (await planView(page)).k).not.toBe(1); // fitted after first frame
  const fitted = await planView(page);
  const label = page.getByRole('group', { name: 'Zoom' }).locator('span');
  await expect(label).toHaveText(`${Math.round(fitted.k * 100)}%`);

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await planView(page)).k).toBeCloseTo(fitted.k * 1.25, 5);
  await expect(label).toHaveText(`${Math.round(fitted.k * 125)}%`);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(async () => (await planView(page)).k).toBeCloseTo(fitted.k * 0.8, 5);

  await page.getByRole('button', { name: 'Fit' }).click();
  expect(await planView(page)).toEqual(fitted);

  // Keyboard on the focused plan: + / - / 0. Clamped at 600 %.
  const vp = page.getByRole('region', { name: /^Plan of Apartment/ });
  await vp.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('+');
  await expect.poll(async () => (await planView(page)).k).toBe(6);
  await expect(label).toHaveText('600%');
  await page.keyboard.press('-');
  await expect.poll(async () => (await planView(page)).k).toBeCloseTo(4.8, 5);
  await page.keyboard.press('0');
  await expect.poll(async () => planView(page)).toEqual(fitted);
});

test('wheel zoom keeps the point under the cursor in place', async ({ page }) => {
  await gotoPlan(page);
  await expect.poll(async () => (await planView(page)).k).not.toBe(1);
  const before = await planView(page);
  const target = (await item(page, DISHWASHER).locator('.bg').boundingBox())!;
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await planView(page)).k).toBeGreaterThan(before.k * 1.2);
  const after = (await item(page, DISHWASHER).locator('.bg').boundingBox())!;
  expect(after.width).toBeGreaterThan(target.width * 1.2);
  expect(Math.abs(after.x + after.width / 2 - cx)).toBeLessThan(1.5);
  expect(Math.abs(after.y + after.height / 2 - cy)).toBeLessThan(1.5);
  // The page itself did not scroll.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('dragging pans the plan and never opens what is under the pointer', async ({ page }) => {
  await gotoPlan(page);
  await expect.poll(async () => (await planView(page)).k).not.toBe(1);
  const before = await planView(page);

  // Drag from the dishwasher: a pan, not a click.
  const b = (await item(page, DISHWASHER).boundingBox())!;
  const start = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 20, { steps: 5 });
  await page.mouse.move(start.x + 80, start.y + 40, { steps: 5 });
  await page.mouse.up();
  const after = await planView(page);
  expect(after.k).toBe(before.k);
  expect(after.tx - before.tx).toBeCloseTo(80, 0);
  expect(after.ty - before.ty).toBeCloseTo(40, 0);
  await expect(panel(page)).toBeHidden();
  await expect(page).toHaveURL('/');

  // Fit restores the fitted view after a pan.
  await page.getByRole('button', { name: 'Fit' }).click();
  expect(await planView(page)).toEqual(before);

  // A small jitter (< 6 px) is still a click.
  const b2 = (await item(page, DISHWASHER).boundingBox())!;
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2 + 3, b2.y + b2.height / 2 + 2);
  await page.mouse.up();
  await expect(page).toHaveURL(`/i/${DISHWASHER}`);
});

test('switching floors refits the plan', async ({ page }) => {
  await gotoPlan(page);
  await expect.poll(async () => (await planView(page)).k).not.toBe(1);
  const fitted = await planView(page);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await floorTab(page, 'Basement').click();
  await floorTab(page, 'Apartment').click();
  await expect.poll(async () => planView(page)).toEqual(fitted);
});

// ---- touch (phone project) -----------------------------------------------------------

test.describe('touch @phone', () => {
  async function touch(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    const send = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      points: { x: number; y: number }[],
    ) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
    return { send };
  }

  test('one-finger drag pans, two-finger pinch zooms around the midpoint', async ({ page }) => {
    await gotoPlan(page);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const vp = await viewportBox(page);
    const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
    const { send } = await touch(page);

    const before = await planView(page);
    await send('touchStart', [c]);
    for (let i = 1; i <= 5; i++) await send('touchMove', [{ x: c.x + 10 * i, y: c.y + 6 * i }]);
    await send('touchEnd', []);
    await expect.poll(async () => (await planView(page)).tx - before.tx).toBeCloseTo(50, 0);
    expect((await planView(page)).ty - before.ty).toBeCloseTo(30, 0);
    await expect(panel(page)).toBeHidden();

    const mid = await planView(page);
    // Plan point under the pinch midpoint before the gesture...
    const local = { x: c.x - vp.x, y: c.y - vp.y };
    const planPt = { x: (local.x - mid.tx) / mid.k, y: (local.y - mid.ty) / mid.k };
    await send('touchStart', [
      { x: c.x - 40, y: c.y },
      { x: c.x + 40, y: c.y },
    ]);
    for (let i = 1; i <= 5; i++) {
      await send('touchMove', [
        { x: c.x - 40 - 8 * i, y: c.y },
        { x: c.x + 40 + 8 * i, y: c.y },
      ]);
    }
    await send('touchEnd', []);
    await expect.poll(async () => (await planView(page)).k / mid.k).toBeCloseTo(2, 1);
    // ...stays under it afterwards. Each finger moves in its own pointer event, so the anchor
    // wobbles by half a step per move; a few px of drift is expected.
    const end = await planView(page);
    expect(Math.abs(end.tx + planPt.x * end.k - local.x)).toBeLessThan(5);
    expect(Math.abs(end.ty + planPt.y * end.k - local.y)).toBeLessThan(5);
  });

  test('a tap after a pinch still opens the item', async ({ page }) => {
    await gotoPlan(page);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const vp = await viewportBox(page);
    const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
    const { send } = await touch(page);
    await send('touchStart', [
      { x: c.x - 30, y: c.y },
      { x: c.x + 30, y: c.y },
    ]);
    await send('touchMove', [
      { x: c.x - 45, y: c.y },
      { x: c.x + 45, y: c.y },
    ]);
    await send('touchEnd', []);
    await item(page, DISHWASHER).tap();
    await expect(page).toHaveURL(`/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  });
});
