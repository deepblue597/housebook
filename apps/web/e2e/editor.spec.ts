/**
 * Milestone 5, the layout editor: edit mode, tools in 2D and 3D (paint/erase with rectangle
 * drag, place from the catalogue (note first, D8), move, rotate, stacking), rooms, resize (D17),
 * undo/redo, debounced saving with If-Match, replay on 412, the Unplaced tray and ghosts.
 * Every test that edits has its own backend (editor role) and checks house.json on disk.
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
  expectNoA11yViolations,
  gotoPlan,
  item,
  panel,
  planView,
  test,
} from './support/fixtures';

const EDITOR_ENV = { HOUSEBOOK_ANON_ROLE: 'editor' };

/** The parts of window.__housebook (app/testHook.ts) these tests use. */
interface Hook {
  ui: { getState: () => { selection: { kind: string; id?: string } | null } };
  data: { getState: () => { me: { role: string } | null } };
  scene: {
    moving: () => boolean;
    cellToScreen: (x: number, y: number) => { x: number; y: number };
    itemToScreen: (id: string) => { x: number; y: number } | null;
    info: () => { items: string[] };
  } | null;
}
const S = 40; // plan units per tile (features/plan2d/geometry.ts)

interface Placement {
  itemId: string;
  floorId: string;
  x: number;
  y: number;
  rotation: number;
}
type House = Omit<HouseJson, 'placements'> & { placements: Placement[] };

const readHouse = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'house.json'), 'utf8')) as House;
const writeHouse = (dir: string, h: House) =>
  writeFileSync(join(dir, 'house.json'), `${JSON.stringify(h, null, 2)}\n`);
const placementOf = (h: House, id: string) => h.placements.find((p) => p.itemId === id);
const cells = (h: House, floor = 'fl_0') => h.floors.find((f) => f.id === floor)!.cells;

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

const editButton = (page: Page) => page.getByRole('button', { name: 'Edit', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Editor' });
const saveState = (page: Page) => page.locator('[data-save]');

async function startEditing(page: Page, url: string, path = '/') {
  await gotoPlan(page, `${url}${path}`);
  await editButton(page).click();
  await expect(sidebar(page)).toBeVisible();
}

/** Wait until the editor reports everything saved (after at least one edit). */
async function saved(page: Page) {
  await expect(saveState(page)).toHaveAttribute('data-save', 'saved', { timeout: 10_000 });
}

test.describe('edit mode', () => {
  test('viewers get no Edit button; editors toggle edit mode with a tool rail', async ({
    page,
    backend,
  }) => {
    await gotoPlan(page);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __housebook: Hook }).__housebook.data.getState().me?.role,
        ),
      )
      .toBe('viewer');
    await expect(editButton(page)).toHaveCount(0);

    const { url } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(editButton(page)).toHaveAttribute('aria-pressed', 'true');
    const rail = page.getByRole('toolbar', { name: 'Editor tools' });
    await expect(rail.getByRole('button', { name: /Select and move/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(sidebar(page).getByRole('heading', { name: 'Rooms' })).toBeVisible();
    await expect(sidebar(page).getByRole('textbox', { name: 'Name of Kitchen' })).toHaveValue(
      'Kitchen',
    );
    await expectNoA11yViolations(page);
    await editButton(page).click();
    await expect(sidebar(page)).toHaveCount(0);
  });
});

test.describe('2D tools', () => {
  test('paint a rectangle by dragging is one undo step; undo and redo are saved', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    // Row y = 9 is empty in the example house: paint (2,9)..(5,9).
    await drag(page, await cell2d(page, 2, 9), await cell2d(page, 5, 9));
    await expect(saveState(page)).not.toHaveAttribute('data-save', 'saved');
    await saved(page);
    let h = readHouse(dataDir);
    for (let x = 2; x <= 5; x++) expect(cells(h)[`${x},9`]).toBe('rm_kit');
    expect(cells(h)['6,9']).toBeUndefined();

    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBeNull();
    h = readHouse(dataDir);
    for (let x = 2; x <= 5; x++) expect(cells(h)[`${x},9`]).toBeUndefined();

    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => cells(readHouse(dataDir))['5,9'] ?? null).toBe('rm_kit');
    await saved(page);
  });

  test('erase a rectangle; the walls follow', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await page
      .getByRole('toolbar', { name: 'Editor tools' })
      .getByRole('button', { name: /Erase/ })
      .click();
    const before = Object.keys(cells(readHouse(dataDir))).length;
    await drag(page, await cell2d(page, 1, 7), await cell2d(page, 2, 8));
    await expect.poll(() => cells(readHouse(dataDir))['1,7'] ?? null).toBeNull();
    const h = readHouse(dataDir);
    expect(Object.keys(cells(h)).length).toBe(before - 4);
    expect(cells(h)['3,7']).toBe('rm_bal');
  });

  test('place a new item from the catalogue: the note first, then the placement', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Add Router' }).click();
    await page.mouse.click(...xy(await cell2d(page, 4, 4)));
    const dialog = page.getByRole('dialog', { name: 'New Router' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('In Living room on Apartment.')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Mesh node');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByRole('heading', { name: 'Mesh node' })).toBeVisible();
    expect(existsSync(join(dataDir, 'House/Living room/Mesh node.md'))).toBe(true);
    await saved(page);
    const note = readFileSync(join(dataDir, 'House/Living room/Mesh node.md'), 'utf8');
    const id = /housebook_id: (\S+)/.exec(note)![1]!;
    expect(placementOf(readHouse(dataDir), id)).toMatchObject({
      floorId: 'fl_0',
      x: 4,
      y: 4,
      rotation: 0,
    });
    await expect(item(page, id)).toBeVisible();
  });

  test('move by drag, rotate with R, remove from plan and place again from the tray', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    // Fridge at (8,1) -> (8,3).
    await drag(page, await cell2d(page, 8, 1), await cell2d(page, 8, 3));
    await expect.poll(() => placementOf(readHouse(dataDir), FRIDGE)?.y).toBe(3);
    await expect(panel(page).getByRole('heading', { name: 'Fridge' })).toBeVisible();

    await page.locator('.viewport').focus();
    await page.keyboard.press('r');
    await expect.poll(() => placementOf(readHouse(dataDir), FRIDGE)?.rotation).toBe(90);

    await panel(page).getByRole('button', { name: 'Remove from plan' }).click();
    await expect.poll(() => placementOf(readHouse(dataDir), FRIDGE)).toBeUndefined();
    const tray = sidebar(page).locator('[data-unplaced-id]');
    await expect(tray).toHaveCount(1);
    expect(existsSync(join(dataDir, 'House/Kitchen/Fridge.md'))).toBe(true);

    await sidebar(page).getByRole('button', { name: 'Place Fridge' }).click();
    await page.mouse.click(...xy(await cell2d(page, 9, 4)));
    await expect.poll(() => placementOf(readHouse(dataDir), FRIDGE)).toMatchObject({ x: 9, y: 4 });
    await expect(tray).toHaveCount(0);

    // Undo three steps: placed again -> removed -> rotation back.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => placementOf(readHouse(dataDir), FRIDGE))
      .toMatchObject({ x: 8, y: 3, rotation: 0 });
  });

  test('drag an item from the Unplaced tray onto the plan', async ({ page, backend }) => {
    const h = exampleHouse() as unknown as House;
    h.placements = h.placements.filter((p) => p.itemId !== DISHWASHER);
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    const row = sidebar(page).locator(`[data-unplaced-id="${DISHWASHER}"]`);
    const target = await cell2d(page, 11, 3);
    await row.dragTo(page.locator('.viewport'), {
      targetPosition: await relative(page, target),
    });
    await expect
      .poll(() => placementOf(readHouse(dataDir), DISHWASHER))
      .toMatchObject({ x: 11, y: 3 });
  });

  test('stacked items: clicking the tile again cycles through them', async ({ page, backend }) => {
    const h = exampleHouse() as unknown as House;
    // Microwave on the fridge's tile.
    placementOf(h, 'it_2c6p1d')!.x = 8;
    placementOf(h, 'it_2c6p1d')!.y = 1;
    const { url } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    const selected = () =>
      page.evaluate(
        () =>
          (window as unknown as { __housebook: Hook }).__housebook.ui.getState().selection?.id ??
          null,
      );
    // The details panel opens on the first click and the plan refits: find the tile each time.
    const clickTile = async () => {
      await expect(page.locator('.plan')).toBeVisible();
      const at = await cell2d(page, 8, 1);
      await page.mouse.click(at.x, at.y);
    };
    await clickTile();
    const first = await selected();
    await expect(panel(page)).toBeVisible();
    await clickTile();
    const second = await selected();
    expect(new Set([first, second])).toEqual(new Set([FRIDGE, 'it_2c6p1d']));
    await clickTile();
    expect(await selected()).toBe(first);
  });
});

test.describe('rooms', () => {
  test('add, rename and recolour a room, paint with it, then delete it when unused', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Add room' }).click();
    const name = sidebar(page).getByRole('textbox', { name: 'Name of Room 10' });
    await expect(name).toBeVisible();
    await name.fill('Garage');
    await name.press('Enter');
    await expect.poll(() => readHouse(dataDir).rooms.map((r) => r.name)).toContain('Garage');
    const garage = readHouse(dataDir).rooms.find((r) => r.name === 'Garage')!;
    expect(garage.id).toMatch(/^rm_[0-9a-z]{6}$/);

    await sidebar(page).getByLabel('Colour of Garage').fill('#123456');
    await expect
      .poll(() =>
        readHouse(dataDir)
          .rooms.find((r) => r.id === garage.id)
          ?.color.toLowerCase(),
      )
      .toBe('#123456');

    // Adding a room arms the paint tool with it.
    await sidebar(page).getByRole('button', { name: 'Paint with Garage' }).click();
    await page.mouse.click(...xy(await cell2d(page, 0, 0)));
    await expect.poll(() => cells(readHouse(dataDir))['0,0']).toBe(garage.id);
    await expect(sidebar(page).getByRole('button', { name: 'Delete Garage' })).toBeDisabled();

    await page.keyboard.press('Control+z');
    await expect(sidebar(page).getByRole('button', { name: 'Delete Garage' })).toBeEnabled();
    await sidebar(page).getByRole('button', { name: 'Delete Garage' }).click();
    await expect.poll(() => readHouse(dataDir).rooms.some((r) => r.id === garage.id)).toBe(false);
  });
});

test.describe('resize the house (D17b)', () => {
  test('growing west and north shifts everything; undo shrinks back', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Resize house…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Resize house' });
    await dialog.getByLabel(/^West side/).fill('2');
    await dialog.getByLabel(/^North side/).fill('1');
    await expect(dialog.getByText('New size: 18 × 11 tiles.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Resize', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(18);
    const h = readHouse(dataDir);
    expect(h.grid.depth).toBe(11);
    expect(cells(h)['9,2']).toBe(cells(before)['7,1']);
    expect(placementOf(h, FRIDGE)).toMatchObject({ x: 10, y: 2 });
    expect(h.openings!.find((o) => o.side === 'w' && o.y === 6 && o.x === 9)).toBeTruthy();
    // The fridge is drawn on its tile in the new frame.
    await expect(item(page, FRIDGE)).toBeVisible();

    await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(16);
    const back = readHouse(dataDir);
    expect(cells(back)).toEqual(cells(before));
    expect(placementOf(back, FRIDGE)).toMatchObject({ x: 8, y: 1 });
  });

  test('shrinking lists what will be lost and needs confirmation; undo restores it', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    const before = readHouse(dataDir);
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Resize house…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Resize house' });
    await dialog.getByLabel(/^East side/).fill('-2');
    await expect(dialog.getByText('This removes:')).toBeVisible();
    await expect(
      dialog.getByText(/painted tiles \(Bedroom 4, Hallway 1, Utility 3\)/),
    ).toBeVisible();
    await expect(dialog.getByText(/Bedroom AC, Washing machine, Main water valve/)).toBeVisible();
    const apply = dialog.getByRole('button', { name: 'Resize and remove' });
    await expect(apply).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Remove these' }).check();
    await apply.click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(14);
    expect(placementOf(readHouse(dataDir), 'it_6h4j9b')).toBeUndefined();
    await expect(sidebar(page).locator('[data-unplaced-id]')).toHaveCount(3);

    await page.keyboard.press('Control+z');
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(16);
    const back = readHouse(dataDir);
    expect(cells(back)).toEqual(cells(before));
    expect(placementOf(back, 'it_6h4j9b')).toMatchObject({ x: 14, y: 1 });
    expect(back.openings).toHaveLength(before.openings!.length);
  });
});

test.describe('saving and conflicts', () => {
  test('saves once, about a second after the last edit, with If-Match', async ({
    page,
    backend,
  }) => {
    const { url } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    const puts: { ifMatch: string | undefined; at: number }[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/house'))
        puts.push({ ifMatch: r.headers()['if-match'], at: Date.now() });
    });
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    const start = Date.now();
    for (const x of [2, 3, 4]) await page.mouse.click(...xy(await cell2d(page, x, 9)));
    await saved(page);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.ifMatch).toMatch(/^"[0-9a-f]+"$/);
    expect(puts[0]!.at - start).toBeGreaterThan(900);
  });

  test('412: pending edits are replayed on the changed layout and saved', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    // No live updates: the save itself must find out about the other change (412).
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    await page.mouse.click(...xy(await cell2d(page, 2, 9)));
    // Someone else renames a room on disk before the debounced save goes out.
    const h = readHouse(dataDir);
    h.rooms.find((r) => r.id === 'rm_bed')!.name = 'Master bedroom';
    writeHouse(dataDir, h);
    await saved(page);
    const after = readHouse(dataDir);
    expect(cells(after)['2,9']).toBe('rm_kit');
    expect(after.rooms.find((r) => r.id === 'rm_bed')!.name).toBe('Master bedroom');
    await expect(page.locator('.ed-notice')).toHaveCount(0);
  });

  test('412: an edit that no longer applies is dropped and the user is told', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.route('**/api/events', (r) => r.abort());
    await startEditing(page, url);
    await sidebar(page).getByRole('button', { name: 'Paint with Storage' }).click();
    await page.mouse.click(...xy(await cell2d(page, 3, 9)));
    // Meanwhile Storage is deleted elsewhere (with its basement tiles).
    const h = readHouse(dataDir);
    h.rooms = h.rooms.filter((r) => r.id !== 'rm_sto');
    for (const f of h.floors)
      for (const [k, v] of Object.entries(f.cells)) if (v === 'rm_sto') delete f.cells[k];
    writeHouse(dataDir, h);
    // Storage is a basement room, so painting it here also says so (#14): look for the drop.
    const notice = page.locator('.ed-notice').filter({ hasText: 'was dropped' });
    await expect(notice).toContainText(
      /“paint 1 tile Storage” was dropped: the room .* no longer exists/,
    );
    await saved(page);
    expect(cells(readHouse(dataDir))['3,9']).toBeUndefined();
    // Nothing left to undo: the dropped edit left the history.
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

  test('a layout change arriving over SSE while edits are pending keeps both', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await startEditing(page, url);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    // Hold the save back so the event arrives while the edit is still pending.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/house', async (r) => {
      if (r.request().method() === 'PUT') await gate;
      await r.continue();
    });
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    await page.mouse.click(...xy(await cell2d(page, 4, 9)));
    const h = readHouse(dataDir);
    h.rooms.find((r) => r.id === 'rm_off')!.name = 'Study';
    writeHouse(dataDir, h);
    // The room list shows the other change while ours is still unsaved.
    await expect(sidebar(page).getByRole('textbox', { name: 'Name of Study' })).toBeVisible();
    release();
    await saved(page);
    const after = readHouse(dataDir);
    expect(cells(after)['4,9']).toBe('rm_kit');
    expect(after.rooms.find((r) => r.id === 'rm_off')!.name).toBe('Study');
  });
});

test.describe('ghosts (missing notes)', () => {
  test('relink a ghost to an unplaced note, remove another', async ({ page, backend }) => {
    const h = exampleHouse() as unknown as House;
    // The dishwasher is unplaced; two placements point at notes that don't exist.
    h.placements = h.placements.filter((p) => p.itemId !== DISHWASHER);
    h.placements.push({ itemId: 'it_gone01', floorId: 'fl_0', x: 4, y: 2, rotation: 0 });
    h.placements.push({ itemId: 'it_gone02', floorId: 'fl_0', x: 5, y: 5, rotation: 0 });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await gotoPlan(page, url);
    await page.locator('[data-ghost-id="it_gone01"]').click();
    await expect(panel(page).getByRole('heading', { name: 'Note missing' })).toBeVisible();
    await expect(panel(page).getByText(/Switch to Edit mode/)).toBeVisible();

    await editButton(page).click();
    await panel(page)
      .getByRole('combobox', { name: /Relink/ })
      .selectOption({ label: 'Dishwasher' });
    await panel(page).getByRole('button', { name: 'Relink' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
    await expect
      .poll(() => placementOf(readHouse(dataDir), DISHWASHER))
      .toMatchObject({ x: 4, y: 2 });
    expect(placementOf(readHouse(dataDir), 'it_gone01')).toBeUndefined();

    await page.locator('[data-ghost-id="it_gone02"]').click();
    await panel(page).getByRole('button', { name: 'Remove placement' }).click();
    await expect.poll(() => placementOf(readHouse(dataDir), 'it_gone02')).toBeUndefined();
    await expect(page.locator('[data-ghost-id]')).toHaveCount(0);
    // Both are one undo step each.
    await page.keyboard.press('Control+z');
    await expect(page.locator('[data-ghost-id="it_gone02"]')).toHaveCount(1);
  });
});

test.describe('3D tools', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('housebook.planStyle', '3d'));
  });

  async function settle(page: Page) {
    await expect(page.locator('.viewport.scene3d')).toHaveAttribute('data-ready', 'true');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __housebook: Hook }).__housebook.scene!.moving(),
        ),
      )
      .toBe(false);
  }
  const cell3d = (page: Page, x: number, y: number) =>
    page.evaluate(
      ([cx, cy]) =>
        (window as unknown as { __housebook: Hook }).__housebook.scene!.cellToScreen(cx!, cy!),
      [x, y],
    );

  test('add a door on a wall in 3D (milestone 7, D36)', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.goto(url);
    await settle(page);
    await editButton(page).click();
    await expect(sidebar(page)).toBeVisible();
    await settle(page);
    await sidebar(page).getByRole('button', { name: 'Door' }).click();
    // Near the west edge of tile (7,1): the wall between the living room and the kitchen.
    // cellToScreen takes tile coordinates and adds half a tile.
    const p = await cell3d(page, 7.08 - 0.5, 1.5 - 0.5);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await saved(page);
    const door = readHouse(dataDir).openings!.find(
      (o) => o.floorId === 'fl_0' && o.x === 7 && o.y === 1 && o.side === 'w',
    );
    expect(door?.kind).toBe('door');
  });

  test('paint a rectangle and move an item in 3D', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, EDITOR_ENV);
    await page.goto(url);
    await settle(page);
    await editButton(page).click();
    await settle(page);
    await sidebar(page).getByRole('button', { name: 'Paint with Office' }).click();
    await drag(page, await cell3d(page, 7, 9), await cell3d(page, 9, 9));
    await expect.poll(() => cells(readHouse(dataDir))['9,9']).toBe('rm_off');
    expect(cells(readHouse(dataDir))['7,9']).toBe('rm_off');
    expect(cells(readHouse(dataDir))['10,9']).toBeUndefined();

    await page
      .getByRole('toolbar', { name: 'Editor tools' })
      .getByRole('button', { name: /Select/ })
      .click();
    // The router is a floor item at (6,6): drag it two tiles east.
    await settle(page);
    const from = await page.evaluate(() =>
      (window as unknown as { __housebook: Hook }).__housebook.scene!.itemToScreen('it_8r2w6z'),
    );
    const to = await cell3d(page, 8, 6);
    const start = await cell3d(page, 6, 6);
    await drag(page, from!, { x: to.x + from!.x - start.x, y: to.y + from!.y - start.y });
    await expect
      .poll(() => placementOf(readHouse(dataDir), 'it_8r2w6z'))
      .toMatchObject({ x: 8, y: 6 });
  });

  test('place an unplaced item in 3D', async ({ page, backend }) => {
    const h = exampleHouse() as unknown as House;
    h.placements = h.placements.filter((p) => p.itemId !== DISHWASHER);
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await page.goto(url);
    await settle(page);
    await editButton(page).click();
    await sidebar(page).getByRole('button', { name: 'Place Dishwasher' }).click();
    await settle(page);
    const at = await cell3d(page, 12, 3);
    await page.mouse.click(at.x, at.y);
    await expect
      .poll(() => placementOf(readHouse(dataDir), DISHWASHER))
      .toMatchObject({ x: 12, y: 3 });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __housebook: Hook }).__housebook.scene!.info().items,
        ),
      )
      .toContain(DISHWASHER);
    expect(readdirSync(join(dataDir, 'House/Kitchen'))).toContain('Dishwasher.md');
  });
});

/** Spread helper for page.mouse.click. */
function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}

/** A page point relative to the plan viewport (for dragTo's targetPosition). */
async function relative(page: Page, p: { x: number; y: number }) {
  const box = (await page.locator('.viewport').boundingBox())!;
  return { x: p.x - box.x, y: p.y - box.y };
}

test.describe('repairs of problems in house.json (D30)', () => {
  test('a hand-edited layout: edits still save; each repair is one undoable edit', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['0,0'] = 'rm_gone'; // a tile of a deleted room
    cells(h)['0,1'] = 'rm_gone';
    cells(h)['17,3'] = 'rm_kit'; // outside the 16 × 10 grid
    h.placements.push({ ...placementOf(h, FRIDGE)!, x: 2, y: 2 }); // the fridge placed twice
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    const repairs = sidebar(page).getByRole('region', { name: 'Problems in the layout' });
    await expect(repairs.locator('[data-issue]')).toHaveCount(3);
    await expect(repairs).toContainText('2 tiles point to a room that doesn’t exist (rm_gone).');
    await expect(repairs).toContainText('Fridge is placed 2 times; the plan shows the first.');
    await expect(repairs).toContainText('Outside the house: 1 tile.');

    // An unrelated edit saves although the problems are still there.
    await sidebar(page).getByRole('button', { name: 'Paint with Kitchen' }).click();
    await page.mouse.click(...xy(await cell2d(page, 2, 9)));
    await saved(page);
    expect(cells(readHouse(dataDir))['2,9']).toBe('rm_kit');

    await repairs.getByRole('button', { name: 'Recreate room' }).click();
    await expect
      .poll(() => readHouse(dataDir).rooms.find((r) => r.id === 'rm_gone')?.name)
      .toBe('Recovered room');
    await repairs.getByRole('button', { name: 'Keep the first' }).click();
    await expect
      .poll(() => readHouse(dataDir).placements.filter((p) => p.itemId === FRIDGE).length)
      .toBe(1);
    await repairs.getByRole('button', { name: 'Grow to 18 × 10' }).click();
    await expect.poll(() => readHouse(dataDir).grid.width).toBe(18);
    await expect(repairs).toHaveCount(0);
    expect(cells(readHouse(dataDir))['17,3']).toBe('rm_kit');

    // Saved repairs can't be undone (the server would refuse a layout that brings a fixed
    // problem back, D30): undo says so and skips them; the paint below is undone.
    await page.keyboard.press('Control+z');
    await expect(page.locator('.ed-notice')).toContainText(/already saved, so it can’t be undone/);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect.poll(() => cells(readHouse(dataDir))['2,9'] ?? null).toBeNull();
    await saved(page);
    expect(readHouse(dataDir).grid.width).toBe(18);
  });

  test('erase the tiles of a missing room; remove what is outside; undo before it is saved', async ({
    page,
    backend,
  }) => {
    const h = exampleHouse() as unknown as House;
    cells(h)['0,0'] = 'rm_gone';
    h.placements.push({ itemId: 'it_far', floorId: 'fl_0', x: 20, y: 1, rotation: 0 });
    const { url, dataDir } = await backend({ house: h }, EDITOR_ENV);
    await startEditing(page, url);
    const repairs = sidebar(page).getByRole('region', { name: 'Problems in the layout' });
    await repairs.getByRole('button', { name: 'Erase tiles' }).click();
    await expect.poll(() => cells(readHouse(dataDir))['0,0'] ?? null).toBeNull();

    // Hold the save: a repair that isn't saved yet can be undone.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/house', async (r) => {
      if (r.request().method() === 'PUT') await gate;
      await r.continue();
    });
    await repairs.getByRole('button', { name: 'Remove what’s outside' }).click();
    await expect(repairs).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(repairs.getByRole('button', { name: 'Remove what’s outside' })).toBeVisible();
    release();
    await saved(page);
    expect(placementOf(readHouse(dataDir), 'it_far')).toMatchObject({ x: 20, y: 1 });
    await expect(page.locator('.ed-notice')).toHaveCount(0);
  });
});
