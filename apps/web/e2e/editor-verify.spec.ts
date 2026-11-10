/**
 * Milestone 5 verification (independent tester): edge cases of the layout editor against a real
 * backend (editor role), checking house.json and the notes on disk. Complements editor.spec.ts.
 *
 * Known bugs are reproduced as `test.fail()` tests named `M5-NN: …`; when one starts passing,
 * Playwright reports it, so drop the `test.fail` line.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  FRIDGE,
  type HouseJson,
  exampleHouse,
  expect,
  gotoPlan,
  item,
  panel,
  planView,
  test,
} from './support/fixtures';

const EDITOR_ENV = { HOUSEBOOK_ANON_ROLE: 'editor' };
const S = 40; // plan units per tile (features/plan2d/geometry.ts)
const VALVE = 'it_6h4j9b'; // Main water valve, (14,1): cut by shrinking the east side by 2
const WASHER = 'it_0k5s2m'; // Washing machine, (14,7): cut by the same shrink

interface Placement {
  itemId: string;
  floorId: string;
  x: number;
  y: number;
  rotation: number;
  footprint?: [number, number];
}
type House = Omit<HouseJson, 'placements'> & { placements: Placement[]; schemaVersion?: number };

const readHouse = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'house.json'), 'utf8')) as House;
const writeHouse = (dir: string, h: House) =>
  writeFileSync(join(dir, 'house.json'), `${JSON.stringify(h, null, 2)}\n`);
const placementOf = (h: House, id: string) => h.placements.find((p) => p.itemId === id);
const cells = (h: House, floor = 'fl_0') => h.floors.find((f) => f.id === floor)!.cells;
const shiftKey = (k: string, dx: number, dy: number) => {
  const [x, y] = k.split(',').map(Number);
  return `${x! + dx},${y! + dy}`;
};

/** The layout grown on the west side by `n` tiles, as another writer would save it. */
function grownWest(h: House, n: number): House {
  const out = structuredClone(h);
  out.grid.width += n;
  for (const f of out.floors)
    f.cells = Object.fromEntries(Object.entries(f.cells).map(([k, v]) => [shiftKey(k, n, 0), v]));
  for (const p of out.placements) p.x += n;
  for (const o of out.openings ?? []) o.x += n;
  return out;
}

/** Centre of tile (x, y) on the 2D plan, in page coordinates. */
async function cell2d(page: Page, x: number, y: number) {
  const box = (await page.locator('svg.plan').boundingBox())!;
  const v = await planView(page);
  return { x: box.x + v.tx + (x + 0.5) * S * v.k, y: box.y + v.ty + (y + 0.5) * S * v.k };
}
async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}
const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

const editButton = (page: Page) => page.getByRole('button', { name: 'Edit', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Editor' });
const saveState = (page: Page) => page.locator('[data-save]');
const notices = (page: Page) => page.locator('.ed-notice');
const undoButton = (page: Page) =>
  page.getByRole('toolbar', { name: 'Editor tools' }).getByRole('button', { name: /^Undo/ });

async function startEditing(page: Page, url: string) {
  await gotoPlan(page, url);
  await editButton(page).click();
  await expect(sidebar(page)).toBeVisible();
}
async function saved(page: Page) {
  await expect(saveState(page)).toHaveAttribute('data-save', 'saved', { timeout: 10_000 });
}
async function paintAt(page: Page, room: string, x: number, y: number) {
  await sidebar(page)
    .getByRole('button', { name: `Paint with ${room}` })
    .click();
  await page.mouse.click(...xy(await cell2d(page, x, y)));
}
async function openResize(
  page: Page,
  by: Partial<Record<'North' | 'East' | 'South' | 'West', number>>,
) {
  await sidebar(page).getByRole('button', { name: 'Resize house…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resize house' });
  for (const [side, n] of Object.entries(by))
    await dialog.getByLabel(new RegExp(`^${side} side`)).fill(String(n));
  return dialog;
}
/** The server writes the first PUT, but its response never reaches the page. */
async function loseFirstSaveResponse(page: Page) {
  let lose = true;
  await page.route('**/api/house', async (r) => {
    if (r.request().method() === 'PUT' && lose) {
      lose = false;
      await r.fetch();
      await r.abort('failed');
      return;
    }
    await r.continue();
  });
}

test.describe('tools and resize edge cases', () => {
  test('a rectangle dragged past the grid edge is clamped to the grid', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    const vp = (await page.locator('.viewport').boundingBox())!;
    await drag(page, await cell2d(page, 13, 8), {
      x: vp.x + vp.width - 2,
      y: vp.y + vp.height - 2,
    });
    await saved(page);
    const h = readHouse(dataDir);
    for (let x = 13; x <= 15; x++)
      for (let y = 8; y <= 9; y++) expect(cells(h)[`${x},${y}`]).toBe('rm_kit');
    for (const k of Object.keys(cells(h))) {
      const [x, y] = k.split(',').map(Number);
      expect(x! < 16 && y! < 10, k).toBe(true);
    }
  });

  test('Esc in the middle of a drag cancels the rectangle', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    const a = await cell2d(page, 2, 9);
    const b = await cell2d(page, 6, 9);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    // An applied edit would have made a history entry synchronously.
    await expect(undoButton(page)).toBeDisabled();
    await expect(saveState(page)).toHaveAttribute('data-save', 'saved');
    expect(cells(readHouse(dataDir))['2,9']).toBeUndefined();
  });

  test('Ctrl+Z while typing a room name is the field’s undo, not the layout’s', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 2, 9);
    await saved(page);
    const name = sidebar(page).getByRole('textbox', { name: 'Name of Office' });
    await name.click();
    await name.press('End');
    await name.pressSequentially('X');
    await name.press('Control+z');
    await expect(undoButton(page)).toHaveAccessibleName(/paint 1 tile Kitchen/);
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');
  });

  test('growing on every side shifts every cell, placement and opening exactly', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    const dialog = await openResize(page, { North: 3, West: 2, East: 1, South: 1 });
    await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(19);
    await saved(page);
    const h = readHouse(dataDir);
    expect(h.grid.depth).toBe(14);
    expect(h.openings).toEqual(before.openings!.map((o) => ({ ...o, x: o.x + 2, y: o.y + 3 })));
    expect(h.placements).toEqual(before.placements.map((p) => ({ ...p, x: p.x + 2, y: p.y + 3 })));
    for (const f of before.floors) {
      const moved = Object.fromEntries(
        Object.entries(f.cells).map(([k, v]) => [shiftKey(k, 2, 3), v]),
      );
      expect(h.floors.find((g) => g.id === f.id)!.cells).toEqual(moved);
    }
    await expect(item(page, FRIDGE)).toBeVisible();
  });

  test('shrinking to 1 × 1 and undoing restores the layout; redo cuts again', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    const dialog = await openResize(page, { East: -15, South: -9 });
    await expect(dialog.getByText('New size: 1 × 1 tiles.')).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Remove these' }).check();
    await dialog.getByRole('button', { name: 'Resize and remove' }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(1);
    await saved(page);
    expect(readHouse(dataDir).placements).toHaveLength(0);
    await expect(sidebar(page).locator('[data-unplaced-id]')).toHaveCount(14);
    await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(16);
    await saved(page);
    const back = readHouse(dataDir);
    expect(back.floors).toEqual(before.floors);
    expect(back.placements).toEqual(before.placements);
    expect(back.openings).toEqual(before.openings);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(1);
  });

  test('512 × 512 is the limit; a large rectangle on it saves', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    const dialog = await openResize(page, { East: 497 });
    await expect(dialog.getByText('Each side must end up between 1 and 512 tiles.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Resize', exact: true })).toBeDisabled();
    await dialog.getByLabel(/^East side/).fill('496');
    await dialog.getByLabel(/^South side/).fill('502');
    await expect(dialog.getByText('New size: 512 × 512 tiles.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(512);
    await saved(page);
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    // Paint thousands of tiles in one drag. Since M5-06, Fit shows the whole 512 × 512 grid,
    // so drag between tiles instead of between the plan's screen corners. (120 × 120: the 2D
    // plan draws one <rect> per tile, so hundreds of thousands of painted tiles are too slow.)
    const c1 = { x: 120, y: 120 };
    await drag(page, await cell2d(page, 1, 1), await cell2d(page, c1.x, c1.y));
    await saved(page);
    const h = readHouse(dataDir);
    expect(cells(h)[`${c1.x},${c1.y}`]).toBe('rm_kit');
    expect(Object.keys(cells(h)).length).toBeGreaterThan(5000);
  });

  test('shrink cuts items, one is placed again from the tray, two undos restore all', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    const dialog = await openResize(page, { East: -2 });
    await dialog.getByRole('checkbox', { name: 'Remove these' }).check();
    await dialog.getByRole('button', { name: 'Resize and remove' }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(14);
    await sidebar(page).getByRole('button', { name: 'Place Washing machine' }).click();
    await page.mouse.click(...xy(await cell2d(page, 2, 2)));
    await expect.poll(() => placementOf(readHouse(dataDir), WASHER)).toMatchObject({ x: 2, y: 2 });
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(16);
    await saved(page);
    const back = readHouse(dataDir);
    expect(back.placements).toEqual(before.placements);
    expect(back.floors).toEqual(before.floors);
    expect(new Set(back.openings!.map((o) => JSON.stringify(o)))).toEqual(
      new Set(before.openings!.map((o) => JSON.stringify(o))),
    );
  });

  test('M5-05: undoing a shrink puts the cut doors/windows back in their original order', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    const dialog = await openResize(page, { East: -2 });
    await dialog.getByRole('checkbox', { name: 'Remove these' }).check();
    await dialog.getByRole('button', { name: 'Resize and remove' }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(14);
    await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(16);
    await saved(page);
    // Undo should leave house.json byte-identical (no reordering diff in git/Obsidian).
    expect(readHouse(dataDir).openings).toEqual(before.openings);
  });

  test('rotating a 3 × 1 footprint in the south-east corner stays inside; undo restores', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    Object.assign(placementOf(h, FRIDGE)!, { x: 13, y: 9, footprint: [3, 1] });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await item(page, FRIDGE).click();
    await expect(panel(page).getByRole('heading', { name: 'Fridge' })).toBeVisible();
    const rotate = panel(page).getByRole('button', { name: /Rotate 90/ });
    await rotate.click();
    await expect
      .poll(() => placementOf(readHouse(dataDir), FRIDGE))
      .toMatchObject({ rotation: 90, x: 13, y: 7 });
    for (let i = 0; i < 3; i++) await rotate.click();
    await saved(page);
    const p = placementOf(readHouse(dataDir), FRIDGE)!;
    expect(p.rotation).toBe(0);
    expect(p.x + 3).toBeLessThanOrEqual(16);
    expect(p.y + 1).toBeLessThanOrEqual(10);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
    await expect
      .poll(() => placementOf(readHouse(dataDir), FRIDGE))
      .toMatchObject({ x: 13, y: 9, rotation: 0 });
  });

  test('M5-04: the resize confirmation is cleared when the loss list changes under it', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    const dialog = await openResize(page, { East: -2 });
    const tick = dialog.getByRole('checkbox', { name: 'Remove these' });
    await tick.check();
    // Meanwhile someone moves the fridge into the strip that will be cut.
    const h = readHouse(dataDir);
    placementOf(h, FRIDGE)!.x = 15;
    writeHouse(dataDir, h);
    await expect(dialog.locator('.resize-loss')).toContainText('Fridge');
    // The user ticked a list without the fridge; the tick must not carry over.
    await expect(tick).not.toBeChecked();
  });
});

test.describe('catalogue, tray and ghosts', () => {
  test('undoing "place new item" keeps the note and puts it in the tray; redo places it', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Add Boiler' }).click();
    await page.mouse.click(...xy(await cell2d(page, 9, 6)));
    const dialog = page.getByRole('dialog', { name: 'New Boiler' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Combi boiler');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toHaveCount(0);
    await saved(page);
    const note = join(dataDir, 'House/Office/Combi boiler.md');
    const id = /housebook_id: (\S+)/.exec(readFileSync(note, 'utf8'))![1]!;
    await page.locator('.viewport').focus();
    await page.keyboard.press('Control+z');
    await expect.poll(() => placementOf(readHouse(dataDir), id)).toBeUndefined();
    expect(existsSync(note)).toBe(true);
    await expect(sidebar(page).locator(`[data-unplaced-id="${id}"]`)).toHaveCount(1);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => placementOf(readHouse(dataDir), id)).toMatchObject({ x: 9, y: 6 });
  });

  test('a new item named like an existing note gets its own file; the old note is untouched', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const fridge = readFileSync(join(dataDir, 'House/Kitchen/Fridge.md'), 'utf8');
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Add Fridge' }).click();
    await page.mouse.click(...xy(await cell2d(page, 9, 3)));
    const dialog = page.getByRole('dialog', { name: 'New Fridge' });
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toHaveCount(0);
    await saved(page);
    expect(readFileSync(join(dataDir, 'House/Kitchen/Fridge.md'), 'utf8')).toBe(fridge);
    const extra = readdirSync(join(dataDir, 'House/Kitchen')).filter(
      (f) => f.startsWith('Fridge') && f !== 'Fridge.md',
    );
    expect(extra).toHaveLength(1);
    const id = /housebook_id: (\S+)/.exec(
      readFileSync(join(dataDir, 'House/Kitchen', extra[0]!), 'utf8'),
    )![1]!;
    expect(placementOf(readHouse(dataDir), id)).toMatchObject({ x: 9, y: 3 });
  });

  test('relinking a ghost is undone in one step; Delete on a ghost removes only the placement', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    h.placements = h.placements.filter((p) => p.itemId !== DISHWASHER);
    h.placements.push({ itemId: 'it_gone01', floorId: 'fl_0', x: 4, y: 2, rotation: 90 });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await page.locator('[data-ghost-id="it_gone01"]').click();
    await panel(page)
      .getByRole('combobox', { name: /Relink/ })
      .selectOption({ label: 'Dishwasher' });
    await panel(page).getByRole('button', { name: 'Relink' }).click();
    await expect
      .poll(() => placementOf(readHouse(dataDir), DISHWASHER))
      .toMatchObject({ x: 4, y: 2, rotation: 90 });
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => placementOf(readHouse(dataDir), 'it_gone01'))
      .toMatchObject({ x: 4, y: 2 });
    await saved(page);
    expect(placementOf(readHouse(dataDir), DISHWASHER)).toBeUndefined();
    await expect(sidebar(page).locator(`[data-unplaced-id="${DISHWASHER}"]`)).toHaveCount(1);

    await page.locator('[data-ghost-id="it_gone01"]').click();
    await page.locator('.viewport').focus();
    await page.keyboard.press('Delete');
    await expect.poll(() => placementOf(readHouse(dataDir), 'it_gone01')).toBeUndefined();
    expect(existsSync(join(dataDir, 'House/Kitchen/Dishwasher.md'))).toBe(true);
  });
});

test.describe('saving, leaving and permissions', () => {
  test('leaving edit mode saves at once, without waiting for the debounce', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    const puts: number[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/house')) puts.push(Date.now());
    });
    await paintAt(page, 'Kitchen', 2, 9);
    const left = Date.now();
    await editButton(page).click();
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBe('rm_kit');
    expect(puts).toHaveLength(1);
    expect(puts[0]! - left).toBeLessThan(500);
  });

  test('a network failure shows an error, keeps the edit and retries until saved', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    let fail = true;
    await page.route('**/api/house', (r) =>
      r.request().method() === 'PUT' && fail ? r.abort('failed') : r.continue(),
    );
    await paintAt(page, 'Kitchen', 2, 9);
    await expect(saveState(page)).toHaveAttribute('data-save', 'error');
    await expect(sidebar(page).getByRole('alert')).toContainText('Couldn’t save the layout');
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(cells(readHouse(dataDir))['2,9']).toBeUndefined();
    fail = false;
    await saved(page); // the automatic retry (2 s) gets through
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');
  });

  test('leaving the page asks first only while edits are unsaved', async ({ page, backend }) => {
    const { url } = await backend({}, EDITOR_ENV);
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.type());
      await d.dismiss();
    });
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 2, 9);
    await saved(page);
    await page.reload(); // everything saved: no prompt
    await editButton(page).click();
    await page.route('**/api/house', (r) =>
      r.request().method() === 'PUT' ? r.abort('failed') : r.continue(),
    );
    await paintAt(page, 'Kitchen', 3, 9);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => dialogs).toEqual(['beforeunload']);
  });

  test('a viewer gets no editing: no Edit button, no shortcuts, PUT refused', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, {});
    const before = readFileSync(join(dataDir, 'house.json'), 'utf8');
    await gotoPlan(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    await expect(editButton(page)).toHaveCount(0);
    await page.locator('.viewport').focus();
    await page.keyboard.press('b');
    await page.mouse.click(...xy(await cell2d(page, 2, 9)));
    await page.keyboard.press('Control+z');
    await expect(sidebar(page)).toHaveCount(0);
    const res = await page.request.put(`${url}/api/house`, {
      data: JSON.parse(before) as unknown,
      headers: { 'If-Match': '*' },
    });
    expect(res.status()).toBe(403);
    expect(readFileSync(join(dataDir, 'house.json'), 'utf8')).toBe(before);
  });

  test('switching 2D → 3D → 2D mid-edit keeps the pending edit, saving and undo/redo', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/house', async (r) => {
      if (r.request().method() === 'PUT') await gate;
      await r.continue();
    });
    await paintAt(page, 'Kitchen', 2, 9);
    await page.getByRole('button', { name: '3D', exact: true }).click();
    await expect(page.locator('.viewport.scene3d')).toHaveAttribute('data-ready', 'true');
    await expect(sidebar(page)).toBeVisible();
    release();
    await saved(page);
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBeNull();
    await page.getByRole('button', { name: '2D', exact: true }).click();
    await expect(page.locator('svg.plan')).toBeVisible();
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBe('rm_kit');
  });

  test('the layout turning read-only while an edit is pending drops it with a message', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/house', async (r) => {
      if (r.request().method() === 'PUT') await gate;
      await r.continue();
    });
    await paintAt(page, 'Kitchen', 2, 9);
    const h = readHouse(dataDir);
    h.schemaVersion = 3; // written by a newer image: read-only (D13)
    writeHouse(dataDir, h);
    release();
    await expect(notices(page)).toContainText('read-only');
    await expect(sidebar(page)).toHaveCount(0);
    expect(readHouse(dataDir).schemaVersion).toBe(3);
    expect(cells(readHouse(dataDir))['2,9']).toBeUndefined();
  });

  test('M5-03: a pre-existing semantic problem in house.json does not block every save', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    // A hand-edited layout: a tile still points to a room that was deleted. Since D30 the server
    // accepts a PUT that doesn't make that worse, and the editor offers a repair.
    cells(h)['0,0'] = 'rm_gone';
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 2, 9);
    await expect(saveState(page)).toHaveAttribute('data-save', 'saved', { timeout: 5_000 });
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');
  });
});

test.describe('concurrent writers', () => {
  test('two tabs editing at once: both edits land; a conflicting one is dropped and told', async ({
    browser,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await startEditing(a, url);
    await startEditing(b, url);
    await paintAt(a, 'Kitchen', 2, 9);
    await paintAt(b, 'Office', 3, 9);
    await saved(a);
    await saved(b);
    await expect.poll(() => cells(readHouse(dataDir))['3,9']).toBe('rm_off');
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');

    // A adds a room; B paints with it while A deletes it. Whichever saves second loses.
    await sidebar(a).getByRole('button', { name: 'Add room' }).click();
    await saved(a);
    const room = readHouse(dataDir).rooms.at(-1)!;
    await expect(sidebar(b).getByRole('button', { name: `Paint with ${room.name}` })).toBeVisible();
    await paintAt(b, room.name, 5, 9);
    await sidebar(a)
      .getByRole('button', { name: `Delete ${room.name}` })
      .click();
    await saved(a);
    await saved(b);
    const h = readHouse(dataDir);
    if (h.rooms.some((r) => r.id === room.id)) expect(cells(h)['5,9']).toBe(room.id);
    else expect(cells(h)['5,9']).toBeUndefined();
    const told = [...(await notices(a).allInnerTexts()), ...(await notices(b).allInnerTexts())];
    expect(told.join('\n')).toMatch(/was dropped/);
    await a.context().close();
    await b.context().close();
  });

  test('an edit whose item was removed elsewhere is dropped with a message', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await drag(page, await cell2d(page, 8, 1), await cell2d(page, 8, 3));
    const h = readHouse(dataDir);
    h.placements = h.placements.filter((p) => p.itemId !== FRIDGE);
    writeHouse(dataDir, h);
    await expect(notices(page)).toContainText(/“move Fridge” was dropped/);
    await saved(page);
    expect(placementOf(readHouse(dataDir), FRIDGE)).toBeUndefined();
  });

  test('M5-02: a pending paint replayed after another writer grew the house west lands on the tile the user painted', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 3, 2); // a living-room tile
    writeHouse(dataDir, grownWest(readHouse(dataDir), 2)); // that tile is (5,2) now
    await saved(page);
    const h = readHouse(dataDir);
    // Either shifted with the house or dropped with a message; never a different tile.
    if (!(await notices(page).count())) expect(cells(h)['5,2']).toBe('rm_kit');
    expect(cells(h)['3,2']).toBe('rm_liv');
  });

  test('M5-02: a pending move replayed after another writer grew the house west keeps its place', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await drag(page, await cell2d(page, 8, 1), await cell2d(page, 8, 3)); // fridge (8,1) → (8,3)
    writeHouse(dataDir, grownWest(readHouse(dataDir), 2));
    await saved(page);
    if (!(await notices(page).count()))
      expect(placementOf(readHouse(dataDir), FRIDGE)).toMatchObject({ x: 10, y: 3 });
    else expect(placementOf(readHouse(dataDir), FRIDGE)).toMatchObject({ x: 10, y: 1 });
  });

  test('M5-02: undo after another writer grew the house west undoes the right tile', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    await paintAt(page, 'Kitchen', 3, 2);
    await saved(page);
    writeHouse(dataDir, grownWest(readHouse(dataDir), 2));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __housebook: { data: { getState: () => { model: { grid: { width: number } } } } };
              }
            ).__housebook.data.getState().model.grid.width,
        ),
      )
      .toBe(18);
    await page.keyboard.press('Control+z');
    // Undone (the tile is living room again) or refused with a message; never a silent no-op.
    await expect
      .poll(
        async () =>
          cells(readHouse(dataDir))['5,2'] === 'rm_liv' || (await notices(page).count()) > 0,
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  test('M5-01: undo still works after a save whose response was lost (paint)', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await loseFirstSaveResponse(page);
    await paintAt(page, 'Kitchen', 2, 9);
    await expect(saveState(page)).toHaveAttribute('data-save', 'error');
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit'); // the server did write it
    await saved(page); // automatic retry: 412 → replay (a no-op) → saved
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => cells(readHouse(dataDir))['2,9'] ?? null, { timeout: 5_000 })
      .toBeNull();
  });

  test('M5-01: undo of a shrink still restores what it cut after its save response was lost', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    await loseFirstSaveResponse(page);
    const dialog = await openResize(page, { East: -2 });
    await dialog.getByRole('checkbox', { name: 'Remove these' }).check();
    await dialog.getByRole('button', { name: 'Resize and remove' }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(14);
    await saved(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width, { timeout: 5_000 }).toBe(16);
    expect(readHouse(dataDir).floors).toEqual(before.floors);
    expect(placementOf(readHouse(dataDir), VALVE)).toMatchObject({ x: 14, y: 1 });
  });
});

test.describe('large houses in 2D', () => {
  test('M5-06: Fit shows the whole plan after growing the house to 200 × 200', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    const dialog = await openResize(page, { East: 184, South: 190 });
    await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(200);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const box = (await page.locator('svg.plan').boundingBox())!;
    const v = await planView(page);
    // The far corner of the grid is inside the plan's box.
    expect(v.tx + 200 * S * v.k).toBeLessThanOrEqual(box.width);
    expect(v.ty + 200 * S * v.k).toBeLessThanOrEqual(box.height);
  });
});

test('editing on a phone: the side bar stacks, a tap paints, no horizontal scroll @phone', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, EDITOR_ENV);
  await gotoPlan(page, url);
  await editButton(page).click();
  await expect(sidebar(page)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
  await page.locator('svg.plan').scrollIntoViewIfNeeded();
  const c = await cell2d(page, 2, 9);
  await page.touchscreen.tap(c.x, c.y);
  await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBe('rm_kit');
});

// ---- re-verification after the M5-01…06 fixes and D30 repairs ---------------------------------

/** Another writer's resize by n/e/s/w tiles, as the editor would save it (content shifted by w, n). */
function resized(h: House, by: { n?: number; e?: number; s?: number; w?: number }): House {
  const { n = 0, e = 0, s = 0, w = 0 } = by;
  const out = structuredClone(h);
  out.grid.width += w + e;
  out.grid.depth += n + s;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < out.grid.width && y < out.grid.depth;
  for (const f of out.floors)
    f.cells = Object.fromEntries(
      Object.entries(f.cells)
        .map(([k, v]) => [shiftKey(k, w, n), v] as const)
        .filter(([k]) => {
          const [x, y] = k.split(',').map(Number);
          return inside(x!, y!);
        }),
    );
  out.placements = out.placements
    .map((p) => ({ ...p, x: p.x + w, y: p.y + n }))
    .filter((p) => inside(p.x, p.y));
  out.openings = (out.openings ?? [])
    .map((o) => ({ ...o, x: o.x + w, y: o.y + n }))
    .filter((o) => o.x >= 0 && o.y >= 0 && o.x <= out.grid.width && o.y <= out.grid.depth);
  return out;
}

/** The grid size the page shows (test hook). */
const shownGrid = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __housebook: {
            data: { getState: () => { model: { grid: { width: number; depth: number } } } };
          };
        }
      ).__housebook.data.getState().model.grid,
  );
const repairs = (page: Page) =>
  sidebar(page).getByRole('region', { name: 'Problems in the layout' });

/** Hold every PUT /api/house until `release()`. */
async function holdSaves(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/house', async (r) => {
    if (r.request().method() === 'PUT') await gate;
    await r.continue();
  });
  return release;
}

test.describe('another writer’s resize (M5-02 fix)', () => {
  test('a pending paint follows a north + west growth', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 3, 2);
    writeHouse(dataDir, resized(readHouse(dataDir), { n: 3, w: 1 }));
    await saved(page);
    const h = readHouse(dataDir);
    expect(cells(h)['4,5']).toBe('rm_kit');
    expect(cells(h)['3,2']).toBeUndefined();
    await expect(notices(page)).toHaveCount(0);
  });

  test('undo history follows a north + west growth that arrives over SSE', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    await paintAt(page, 'Kitchen', 3, 2);
    await saved(page);
    writeHouse(dataDir, resized(readHouse(dataDir), { n: 2, w: 1 }));
    await expect.poll(async () => (await shownGrid(page)).depth).toBe(12);
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['4,4']).toBe('rm_liv');
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => cells(readHouse(dataDir))['4,4']).toBe('rm_kit');
  });

  test('a resize mixed with another change drops the pending edit and clears the history, saying so', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 2, 9);
    await saved(page);
    await paintAt(page, 'Kitchen', 3, 2);
    const next = resized(readHouse(dataDir), { w: 2 });
    cells(next)['0,0'] = 'rm_bed'; // and paints a tile
    writeHouse(dataDir, next);
    await saved(page);
    const h = readHouse(dataDir);
    expect(cells(h)['3,2']).toBe('rm_liv');
    expect(cells(h)['5,2']).toBe('rm_liv');
    await expect(
      notices(page).filter({
        hasText: /“paint 1 tile Kitchen” was dropped: the house was resized elsewhere/,
      }),
    ).toHaveCount(1);
    await expect(notices(page).filter({ hasText: 'undo history no longer fits' })).toHaveCount(1);
    await expect(undoButton(page)).toBeDisabled();
  });

  test('an ambiguous resize (nothing to tell the shift by) drops the pending edit with a message', async ({
    page,
    backend,
  }) => {
    const h0 = exampleHouse() as unknown as House;
    for (const f of h0.floors) f.cells = {};
    h0.placements = [];
    h0.openings = [];
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 3, 2);
    writeHouse(dataDir, resized(readHouse(dataDir), { w: 2 }));
    await saved(page);
    expect(cells(readHouse(dataDir))).toEqual({});
    await expect(notices(page)).toContainText(['was dropped: the house was resized elsewhere']);
  });

  test('pending [paint, own resize, paint] while another writer grows south: the resize and what follows are dropped', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    const release = await holdSaves(page);
    await paintAt(page, 'Kitchen', 2, 9);
    const dialog = await openResize(page, { West: 2 });
    await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
    await paintAt(page, 'Office', 0, 0); // a tile of the grown grid
    writeHouse(dataDir, resized(readHouse(dataDir), { s: 1 }));
    release();
    await saved(page);
    const h = readHouse(dataDir);
    expect(h.grid).toMatchObject({ width: 16, depth: 11 });
    expect(cells(h)['2,9']).toBe('rm_kit');
    expect(cells(h)['0,0']).toBeUndefined();
    await expect(notices(page)).toContainText([/“resize the house to 18 × 10” was dropped/]);
  });

  test('pending [paint, own resize, paint] while another writer renames a room: all kept, all undoable', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 2, 9);
    const dialog = await openResize(page, { West: 2 });
    await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
    await paintAt(page, 'Office', 0, 0);
    const other = readHouse(dataDir);
    other.rooms.find((r) => r.id === 'rm_bed')!.name = 'Master';
    writeHouse(dataDir, other);
    await saved(page);
    const h = readHouse(dataDir);
    expect(h.grid.width).toBe(18);
    expect(cells(h)['4,9']).toBe('rm_kit');
    expect(cells(h)['0,0']).toBe('rm_off');
    expect(h.rooms.find((r) => r.id === 'rm_bed')!.name).toBe('Master');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(16);
    await saved(page);
    expect(cells(readHouse(dataDir))['2,9']).toBeUndefined();
    expect(readHouse(dataDir).rooms.find((r) => r.id === 'rm_bed')!.name).toBe('Master');
  });

  test('M5-07: a pending paint after another writer shifted the house without changing its size', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await paintAt(page, 'Kitchen', 3, 2); // a living-room tile
    // One resize dialog with West +1 and East −1 (or two resizes before this tab hears of them):
    // the size is the same, everything moved one tile east.
    writeHouse(dataDir, resized(readHouse(dataDir), { w: 1, e: -1 }));
    await saved(page);
    const h = readHouse(dataDir);
    // Shifted with the house or dropped with a message; never a different tile.
    if (!(await notices(page).count())) expect(cells(h)['4,2']).toBe('rm_kit');
    expect(cells(h)['3,2']).toBe('rm_liv');
  });
});

test.describe('lost save responses (M5-01 fix)', () => {
  test('another edit made before the retry: both saved and both undoable (SSE on)', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await loseFirstSaveResponse(page);
    const failed = page.waitForEvent('requestfailed', (r) => r.method() === 'PUT');
    await paintAt(page, 'Kitchen', 2, 9);
    await failed;
    await paintAt(page, 'Kitchen', 3, 9);
    await saved(page);
    expect(cells(readHouse(dataDir))['3,9']).toBe('rm_kit');
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['3,9'] ?? null).toBeNull();
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBeNull();
    await expect(notices(page)).toHaveCount(0);
  });

  test('another writer’s edit before the retry: undo still works, their edit stays', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await loseFirstSaveResponse(page);
    const failed = page.waitForEvent('requestfailed', (r) => r.method() === 'PUT');
    await paintAt(page, 'Kitchen', 2, 9);
    await failed;
    const h = readHouse(dataDir);
    h.rooms.find((r) => r.id === 'rm_bed')!.name = 'Master';
    writeHouse(dataDir, h);
    await saved(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBeNull();
    expect(readHouse(dataDir).rooms.find((r) => r.id === 'rm_bed')!.name).toBe('Master');
  });

  test('a move whose response was lost is undone', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await loseFirstSaveResponse(page);
    const failed = page.waitForEvent('requestfailed', (r) => r.method() === 'PUT');
    await drag(page, await cell2d(page, 8, 1), await cell2d(page, 8, 3));
    await failed;
    await saved(page);
    expect(placementOf(readHouse(dataDir), FRIDGE)?.y).toBe(3);
    await page.keyboard.press('Control+z');
    await expect.poll(() => placementOf(readHouse(dataDir), FRIDGE)?.y).toBe(1);
  });
});

test.describe('repairs of a hand-broken house.json (D30)', () => {
  test('every kind of problem at once: fixed one by one, /api/problems is clean; saved repairs refuse undo, then undo goes on', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['0,0'] = 'rm_gone';
    cells(h, 'fl_b1')['0,0'] = 'rm_gone';
    cells(h)['17,3'] = 'rm_kit';
    h.placements.push({ ...placementOf(h, FRIDGE)!, x: 2, y: 2 });
    h.placements.push({ ...placementOf(h, FRIDGE)!, x: 3, y: 2 });
    h.placements.push({ itemId: 'it_ghostx', floorId: 'fl_none', x: 1, y: 1, rotation: 0 });
    h.openings!.push({ floorId: 'fl_none', x: 1, y: 1, side: 'n', kind: 'door' });
    h.placements.push({ itemId: 'it_far01', floorId: 'fl_0', x: 30, y: 30, rotation: 0 });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await expect(repairs(page).locator('[data-issue]')).toHaveCount(4);
    await expect(repairs(page)).toContainText('Fridge is placed 3 times');
    await expect(repairs(page)).toContainText('Outside the house: 1 tile; it_far01.');
    await expect(repairs(page)).toContainText(
      'On a floor that doesn’t exist: it_ghostx; 1 door or window.',
    );
    await expect(repairs(page).getByRole('button', { name: 'Grow to 31 × 31' })).toBeVisible();
    // An unrelated edit saves on the broken layout.
    await paintAt(page, 'Kitchen', 2, 9);
    await saved(page);
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');

    await repairs(page).getByRole('button', { name: 'Erase tiles' }).click();
    await repairs(page).getByRole('button', { name: 'Keep the first' }).click();
    await repairs(page).getByRole('button', { name: 'Remove them' }).click();
    await repairs(page).getByRole('button', { name: 'Remove what’s outside' }).click();
    await expect(repairs(page)).toHaveCount(0);
    await saved(page);
    const report = (await (await page.request.get(`${url}/api/problems`)).json()) as {
      count: number;
    };
    expect(report.count).toBe(0);

    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
    await expect(
      notices(page).filter({ hasText: /is already saved, so it can’t be undone/ }),
    ).toHaveCount(4);
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBeNull();
    await saved(page);
    const after = readHouse(dataDir);
    expect(cells(after)['0,0']).toBeUndefined();
    expect(after.placements.filter((p) => p.itemId === FRIDGE)).toHaveLength(1);
  });

  test('content beyond the 512 limit: only "Remove what’s outside" is offered', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['600,0'] = 'rm_kit';
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await expect(
      repairs(page).getByRole('button', { name: 'Remove what’s outside' }),
    ).toBeVisible();
    await expect(repairs(page).getByRole('button', { name: /^Grow/ })).toHaveCount(0);
    await repairs(page).getByRole('button', { name: 'Remove what’s outside' }).click();
    await saved(page);
    expect(cells(readHouse(dataDir))['600,0']).toBeUndefined();
  });

  test('"Grow" undone before it is saved keeps what was outside (tile and window)', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['17,3'] = 'rm_kit';
    h.openings!.push({ floorId: 'fl_0', x: 19, y: 4, side: 'w', kind: 'window' });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    const release = await holdSaves(page);
    await repairs(page).getByRole('button', { name: 'Grow to 19 × 10' }).click();
    await expect(repairs(page)).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(repairs(page).getByRole('button', { name: 'Grow to 19 × 10' })).toBeVisible();
    release();
    await saved(page);
    const after = readHouse(dataDir);
    expect(after.grid.width).toBe(16);
    expect(cells(after)['17,3']).toBe('rm_kit');
    expect(after.openings!.some((o) => o.x === 19 && o.side === 'w')).toBe(true);
  });

  test('"Keep the first" undone before it is saved puts the copy back in place', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    h.placements.splice(3, 0, { ...placementOf(h, FRIDGE)!, x: 2, y: 2 });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    const before = readHouse(dataDir).placements;
    await startEditing(page, url);
    const release = await holdSaves(page);
    await repairs(page).getByRole('button', { name: 'Keep the first' }).click();
    await page.keyboard.press('Control+z');
    await expect(repairs(page).getByRole('button', { name: 'Keep the first' })).toBeVisible();
    release();
    await saved(page);
    expect(readHouse(dataDir).placements).toEqual(before);
  });

  test('a repair racing an external edit that adds more bad tiles: saved, the rest still listed', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['0,0'] = 'rm_gone';
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await repairs(page).getByRole('button', { name: 'Erase tiles' }).click();
    const other = readHouse(dataDir);
    cells(other)['0,9'] = 'rm_gone';
    cells(other)['1,9'] = 'rm_gone';
    writeHouse(dataDir, other);
    await saved(page);
    expect(cells(readHouse(dataDir))['0,0']).toBeUndefined();
    expect(cells(readHouse(dataDir))['0,9']).toBe('rm_gone');
    await expect(repairs(page)).toContainText('2 tiles point to a room that doesn’t exist');
  });

  test('two tabs repair the same problem differently at once: both save, nothing left to repair', async ({
    browser,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['0,0'] = 'rm_gone';
    cells(h)['0,1'] = 'rm_gone';
    const { url } = await backend({ house: h }, EDITOR_ENV);
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await startEditing(a, url);
    await startEditing(b, url);
    await repairs(a).getByRole('button', { name: 'Erase tiles' }).click();
    await repairs(b).getByRole('button', { name: 'Recreate room' }).click();
    await saved(a);
    await saved(b);
    await expect(repairs(a)).toHaveCount(0);
    await expect(repairs(b)).toHaveCount(0);
    const report = (await (await a.request.get(`${url}/api/problems`)).json()) as {
      count: number;
    };
    expect(report.count).toBe(0);
    await a.context().close();
    await b.context().close();
  });

  test('M5-08: "Recreate room" for a tile naming a room that isn’t a valid id', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['0,0'] = 'Garage room'; // a room name typed by hand instead of its id
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await expect(repairs(page)).toContainText('(Garage room)');
    const recreate = repairs(page).getByRole('button', { name: 'Recreate room' });
    // Either not offered (only "Erase tiles"), or it must produce a layout the server accepts.
    if (await recreate.count()) {
      await recreate.click();
      await saved(page);
      expect(cells(readHouse(dataDir))['0,0']).toBeDefined();
    }
    await expect(saveState(page)).not.toHaveAttribute('data-save', 'error');
  });

  test('M5-09: "Remove what’s outside" removes the copy outside, not the one on the plan', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    h.placements.push({ ...placementOf(h, FRIDGE)!, x: 20, y: 2 }); // a second copy, outside
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await repairs(page).getByRole('button', { name: 'Remove what’s outside' }).click();
    await saved(page);
    expect(readHouse(dataDir).placements.filter((p) => p.itemId === FRIDGE)).toEqual([
      expect.objectContaining({ floorId: 'fl_0', x: 8, y: 1 }),
    ]);
  });

  test('M5-09: "Remove them" removes the copy on the missing floor, not the one on the plan', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    h.placements.push({ ...placementOf(h, FRIDGE)!, floorId: 'fl_gone' }); // a second copy
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    await repairs(page).getByRole('button', { name: 'Remove them' }).click();
    await saved(page);
    expect(readHouse(dataDir).placements.filter((p) => p.itemId === FRIDGE)).toEqual([
      expect.objectContaining({ floorId: 'fl_0', x: 8, y: 1 }),
    ]);
  });
});

test.describe('house.json turning invalid while an edit is pending', () => {
  test('with SSE: the edit is dropped with the read-only message, no save is attempted', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/house')) puts.push(r.url());
    });
    await paintAt(page, 'Kitchen', 2, 9);
    writeFileSync(join(dataDir, 'house.json'), '{ "schemaVersion": 1, broken');
    await expect(notices(page)).toContainText(['read-only']);
    await expect(sidebar(page)).toHaveCount(0);
    expect(puts).toHaveLength(0);
    expect(readFileSync(join(dataDir, 'house.json'), 'utf8')).toContain('broken');
  });

  test('M5-10: without SSE (412 path only): the edit is dropped as read-only, not retried in a loop', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/house')) puts.push(r.url());
    });
    await paintAt(page, 'Kitchen', 2, 9);
    writeFileSync(join(dataDir, 'house.json'), '{ "schemaVersion": 1, broken');
    // GET /api/house answers the last good layout with X-Housebook-Read-Only: true; the editor
    // should take that as "read-only" (D25) instead of replaying and retrying the 412.
    await expect(notices(page)).toContainText(['read-only'], { timeout: 5_000 });
    await expect(page.getByText('the layout kept changing on the server')).toHaveCount(0);
    expect(puts.length).toBeLessThanOrEqual(2);
  });
});

// ---- round 3: M5-07 heuristic (false positives), M5-08 odd ids, M5-10 recovery --------------

/**
 * Paint (3,2) — a living-room tile — with SSE off, let `other` rewrite house.json before the
 * save, and return the saved layout and the editor's messages.
 */
async function paintThenOtherWrites(
  page: Page,
  url: string,
  dataDir: string,
  other: (h: House) => House,
  at: { x: number; y: number; room: string } = { x: 3, y: 2, room: 'Kitchen' },
) {
  await page.route('**/api/events', (r) => r.abort());
  await startEditing(page, url);
  await paintAt(page, at.room, at.x, at.y);
  writeHouse(dataDir, other(readHouse(dataDir)));
  await saved(page);
  return { h: readHouse(dataDir), told: await notices(page).allInnerTexts() };
}

test.describe('M5-07 heuristic: ordinary edits by another writer are not a shift', () => {
  test('another writer repaints a whole room: the pending paint stays where it was made', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (h0) => {
      for (const [k, v] of Object.entries(cells(h0))) if (v === 'rm_kit') cells(h0)[k] = 'rm_off';
      return h0;
    });
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(cells(h)['4,2']).toBe('rm_liv');
    expect(told).toEqual([]);
  });

  test('another writer moves every item one tile east: tiles and the pending paint stay', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (h0) => {
      for (const p of h0.placements) if (p.x < 15) p.x += 1;
      return h0;
    });
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(cells(h)['4,2']).toBe('rm_liv');
    expect(told).toEqual([]);
  });

  test('another writer removes most items: the pending paint stays', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (h0) => {
      h0.placements = h0.placements.slice(0, 2);
      return h0;
    });
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(h.placements).toHaveLength(2);
    expect(told).toEqual([]);
  });

  test('a single-room house shifted east (same size): the pending paint follows', async ({
    page,
    backend,
  }) => {
    const h0 = exampleHouse() as unknown as House;
    for (const f of h0.floors) f.cells = {};
    for (let x = 1; x <= 12; x++) for (let y = 1; y <= 8; y++) cells(h0)[`${x},${y}`] = 'rm_liv';
    h0.placements = [];
    h0.openings = [];
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (x) =>
      resized(x, { w: 1, e: -1 }),
    );
    expect(cells(h)['4,2']).toBe('rm_kit');
    expect(cells(h)['3,2']).toBe('rm_liv');
    expect(told).toEqual([]);
  });

  test('a same-size shift on both axes: the pending paint follows', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (x) =>
      resized(x, { w: 1, e: -1, n: 1, s: -1 }),
    );
    expect(cells(h)['4,3']).toBe('rm_kit');
    expect(cells(h)['3,2']).toBe('rm_liv');
    expect(told).toEqual([]);
  });

  test('a same-size shift plus another edit: the pending paint is dropped with a message', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (x) => {
      const out = resized(x, { w: 1, e: -1 });
      cells(out)['0,9'] = 'rm_bed';
      return out;
    });
    expect(cells(h)['3,2']).toBe('rm_liv');
    expect(cells(h)['4,2']).toBe('rm_liv');
    expect(told.join('\n')).toMatch(/was dropped: the house was resized elsewhere/);
  });

  test('M5-11: in a house with no painted tiles, another writer moving its items is not a shift', async ({
    page,
    backend,
  }) => {
    // First-run style: items placed, no rooms painted yet, no doors or windows.
    const h0 = exampleHouse() as unknown as House;
    for (const f of h0.floors) f.cells = {};
    h0.openings = [];
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    // This user paints (3,2); meanwhile another writer moves every item one tile east.
    const { h } = await paintThenOtherWrites(page, url, dataDir, (x) => {
      for (const p of x.placements) p.x += 1;
      return x;
    });
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(cells(h)['4,2']).toBeUndefined();
  });
});

test.describe('M5-11 variant', () => {
  test('M5-11: in a house with one placed item and no painted tiles, another writer moving it is not a shift', async ({
    page,
    backend,
  }) => {
    const h0 = exampleHouse() as unknown as House;
    for (const f of h0.floors) f.cells = {};
    h0.openings = [];
    h0.placements = h0.placements.filter((p) => p.itemId === FRIDGE);
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    const { h } = await paintThenOtherWrites(page, url, dataDir, (x) => {
      placementOf(x, FRIDGE)!.x += 1; // the fridge moved one tile east
      return x;
    });
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(cells(h)['4,2']).toBeUndefined();
  });
});

test.describe('M5-08: recreate rooms whose "id" is not one', () => {
  test('odd characters, an over-long name and an empty value at once: three valid rooms, exact undo', async ({
    page,
    backend,
  }) => {
    const h0 = exampleHouse() as unknown as House;
    const odd = 'Küche / άλφα 🙂 "x"';
    const long = `Room ${'x'.repeat(150)}`;
    cells(h0)['0,0'] = odd;
    cells(h0)['0,1'] = odd;
    cells(h0)['0,9'] = long;
    cells(h0)['1,9'] = '';
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    await expect(repairs(page).locator('[data-issue="unknown_room"]')).toHaveCount(3);
    const release = await holdSaves(page);
    for (let i = 0; i < 3; i++)
      await repairs(page).getByRole('button', { name: 'Recreate room' }).first().click();
    await expect(repairs(page)).toHaveCount(0);
    // Undo all three before saving: back to the original, byte for byte.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await expect(repairs(page).locator('[data-issue="unknown_room"]')).toHaveCount(3);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+z');
    release();
    await saved(page);
    const h = readHouse(dataDir);
    const added = h.rooms.filter((r) => !before.rooms.some((b) => b.id === r.id));
    expect(added).toHaveLength(3);
    for (const r of added) {
      expect(r.id).toMatch(/^rm_[0-9a-z]{6}$/);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.name.length).toBeLessThanOrEqual(100);
    }
    expect(added.map((r) => r.name)).toContain(odd);
    const byId = new Map(added.map((r) => [r.id, r.name]));
    expect(byId.get(cells(h)['0,0']!)).toBe(odd);
    expect(cells(h)['0,1']).toBe(cells(h)['0,0']);
    expect(cells(h)['0,9']).not.toBe(cells(h)['1,9']);
    expect(added.every((r) => Object.values(cells(h)).includes(r.id))).toBe(true);
    const report = (await (await page.request.get(`${url}/api/problems`)).json()) as {
      count: number;
    };
    expect(report.count).toBe(0);
  });
});

test.describe('M5-10: house.json invalid, then valid again', () => {
  for (const sse of [true, false]) {
    test(`SSE ${sse ? 'on' : 'off'}: the edit is dropped as read-only; once the file is fixed, editing works again`, async ({
      page,
      backend,
    }) => {
      const { url, dataDir } = await backend({}, EDITOR_ENV);
      if (!sse) await page.route('**/api/events', (r) => r.abort());
      await startEditing(page, url);
      if (sse) await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
      const good = readFileSync(join(dataDir, 'house.json'), 'utf8');
      const puts: number[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PUT' && r.url().endsWith('/api/house')) puts.push(Date.now());
      });
      await paintAt(page, 'Kitchen', 2, 9);
      writeFileSync(join(dataDir, 'house.json'), '{ "schemaVersion": 1, broken');
      await expect(notices(page)).toContainText(['read-only'], { timeout: 5_000 });
      await expect(sidebar(page)).toHaveCount(0);
      expect(puts.length).toBeLessThanOrEqual(1);
      await expect(page.getByText('kept changing')).toHaveCount(0);
      expect(readFileSync(join(dataDir, 'house.json'), 'utf8')).toContain('broken');

      // Fixed by hand: the layout is writable again (SSE, or a focus revalidation without it).
      writeFileSync(join(dataDir, 'house.json'), good);
      if (!sse) {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      }
      await expect(editButton(page)).not.toHaveAttribute('aria-disabled', 'true', {
        timeout: 10_000,
      });
      await editButton(page).click();
      await expect(sidebar(page)).toBeVisible();
      await paintAt(page, 'Kitchen', 3, 9);
      await saved(page);
      expect(cells(readHouse(dataDir))['3,9']).toBe('rm_kit');
      expect(cells(readHouse(dataDir))['2,9']).toBeUndefined();
    });
  }
});

test.describe('M5-11 variations (final round)', () => {
  /** The example house with no painted tiles and no doors/windows (first-run style). */
  const bare = () => {
    const h0 = exampleHouse() as unknown as House;
    for (const f of h0.floors) f.cells = {};
    h0.openings = [];
    return h0;
  };
  const moveAllEast = (x: House) => {
    for (const p of x.placements) p.x += 1;
    return x;
  };

  test('first-run house: painting the first room while another writer moves an item keeps both', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({ house: bare() }, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    await drag(page, await cell2d(page, 1, 1), await cell2d(page, 4, 3));
    const other = readHouse(dataDir);
    placementOf(other, FRIDGE)!.x += 1;
    writeHouse(dataDir, other);
    await saved(page);
    const h = readHouse(dataDir);
    expect(Object.keys(cells(h)).sort()).toEqual(
      [1, 2, 3, 4].flatMap((x) => [1, 2, 3].map((y) => `${x},${y}`)).sort(),
    );
    expect(placementOf(h, FRIDGE)!.x).toBe(9);
    await expect(notices(page)).toHaveCount(0);
  });

  test('no tiles, no openings: another writer growing the house drops the pending edit with a message', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({ house: bare() }, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (x) => {
      x.grid.width += 2;
      return x;
    });
    expect(cells(h)).toEqual({});
    expect(told.join('\n')).toMatch(/was dropped: the house was resized elsewhere/);
  });

  test('one painted tile: a real same-size shift is still translated', async ({
    page,
    backend,
  }) => {
    const h0 = bare();
    cells(h0)['10,8'] = 'rm_off';
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, (x) =>
      resized(x, { w: 1, e: -1 }),
    );
    expect(cells(h)['4,2']).toBe('rm_kit');
    expect(cells(h)['11,8']).toBe('rm_off');
    expect(told).toEqual([]);
  });

  test('M5-12: one painted tile: another writer moving every item east is not a shift (edit kept, no message)', async ({
    page,
    backend,
  }) => {
    test.fail(); // safe today (no wrong tile) but dropped as "resized elsewhere" + history cleared
    const h0 = bare();
    cells(h0)['10,8'] = 'rm_off';
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, moveAllEast);
    expect(cells(h)['4,2']).toBeUndefined(); // never translated to a wrong tile
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(told).toEqual([]);
  });

  test('M5-12: openings only: another writer moving every item east is not a shift (edit kept, no message)', async ({
    page,
    backend,
  }) => {
    test.fail(); // safe today (no wrong tile) but dropped as "resized elsewhere" + history cleared
    const h0 = bare();
    h0.openings = [{ floorId: 'fl_0', x: 5, y: 5, side: 'n', kind: 'door' }];
    const { url, dataDir } = await backend({ house: h0 }, EDITOR_ENV);
    const { h, told } = await paintThenOtherWrites(page, url, dataDir, moveAllEast);
    expect(cells(h)['4,2']).toBeUndefined(); // never translated to a wrong tile
    expect(cells(h)['3,2']).toBe('rm_kit');
    expect(told).toEqual([]);
  });
});
