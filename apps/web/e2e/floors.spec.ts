/**
 * Milestone 7: editing floors (D35) against the real backend: add, rename, reorder, delete with
 * what is on them, undo, and the outline of the floor below.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  CHEST_FREEZER,
  expect,
  expectNoA11yViolations,
  floorTab,
  gotoPlan,
  planView,
  test,
} from './support/fixtures';

interface House {
  floors: { id: string; name: string; level: number; cells: Record<string, string> }[];
  placements: { itemId: string; floorId: string }[];
  openings: { floorId: string; x: number; y: number; side: string; kind: string }[];
}
const readHouse = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'house.json'), 'utf8')) as House;
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Editor' });
const floors = (page: Page) => sidebar(page).getByRole('region', { name: 'Floors' });
const tabs = (page: Page) => page.getByRole('group', { name: 'Floors' }).getByRole('button');
async function saved(page: Page) {
  await expect(page.locator('[data-save]')).toHaveAttribute('data-save', 'saved', {
    timeout: 10_000,
  });
}

async function startEditing(page: Page, url: string) {
  await gotoPlan(page, url);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(sidebar(page)).toBeVisible();
}

test.describe('floors', () => {
  test('add above, rename, see the floor below, move it down', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await startEditing(page, url);
    await expect(tabs(page)).toHaveText(['Apartment', 'Basement']);

    await floors(page).getByRole('button', { name: '+ Floor above' }).click();
    await expect(tabs(page)).toHaveText(['Floor 1', 'Apartment', 'Basement']);
    await expect(floorTab(page, 'Floor 1')).toHaveAttribute('aria-pressed', 'true'); // shown
    // The apartment's walls show under the new, empty floor.
    await expect(page.locator('.plan .underlay')).toHaveAttribute('data-underlay', 'fl_0');
    await saved(page);
    const added = readHouse(dataDir).floors.find((f) => f.name === 'Floor 1')!;
    expect(added).toMatchObject({ level: 1, cells: {} });

    const name = floors(page).getByRole('textbox', { name: 'Name of Floor 1' });
    await name.fill('Upstairs');
    await name.press('Enter');
    await expect(tabs(page)).toHaveText(['Upstairs', 'Apartment', 'Basement']);
    await saved(page);
    expect(readHouse(dataDir).floors.find((f) => f.id === added.id)!.name).toBe('Upstairs');

    await floors(page).getByRole('button', { name: 'Move Upstairs down' }).click();
    await expect(tabs(page)).toHaveText(['Apartment', 'Upstairs', 'Basement']);
    await saved(page);
    const levels = Object.fromEntries(readHouse(dataDir).floors.map((f) => [f.name, f.level]));
    expect(levels).toEqual({ Apartment: 1, Upstairs: 0, Basement: -1 });
    await expectNoA11yViolations(page);

    // The basement has nothing below it: no outline.
    await floorTab(page, 'Basement').click();
    await expect(page.locator('.plan .underlay')).toHaveCount(0);
  });

  test('delete a floor with what is on it; undo brings it all back; never the last one', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await startEditing(page, url);
    const before = readHouse(dataDir);

    await floors(page).getByRole('button', { name: 'Delete Basement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete “Basement”?' });
    await expect(dialog).toContainText('20 tiles of');
    await expect(dialog).toContainText('Chest freezer');
    await expect(dialog).toContainText('1 door or window');
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Delete floor' }).click();

    await expect(tabs(page)).toHaveText(['Apartment']);
    await expect(sidebar(page).locator(`[data-unplaced-id="${CHEST_FREEZER}"]`)).toBeVisible();
    await saved(page);
    const after = readHouse(dataDir);
    expect(after.floors.map((f) => f.id)).toEqual(['fl_0']);
    expect(after.placements.map((p) => p.itemId)).not.toContain(CHEST_FREEZER);
    expect(after.openings.every((o) => o.floorId === 'fl_0')).toBe(true);
    // The last floor can't go.
    await expect(floors(page).getByRole('button', { name: 'Delete Apartment' })).toBeDisabled();

    await page.keyboard.press('Control+z');
    await expect(tabs(page)).toHaveText(['Apartment', 'Basement']);
    await saved(page);
    expect(readHouse(dataDir)).toEqual(before);
  });
});

const S = 40; // plan units per tile (features/plan2d/geometry.ts)
/** A point on the 2D plan, in tiles (fractions allowed). */
async function at(page: Page, x: number, y: number) {
  const box = (await page.locator('svg.plan').boundingBox())!;
  const v = await planView(page);
  return { x: box.x + v.tx + x * S * v.k, y: box.y + v.ty + y * S * v.k };
}
const kitchenWall = (h: House) =>
  h.openings.find((o) => o.floorId === 'fl_0' && o.x === 7 && o.y === 1 && o.side === 'w');

test.describe('doors and windows', () => {
  test('click a wall to add a door, swap it to a window, remove it; not inside a room', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await startEditing(page, url);
    const rail = sidebar(page);
    // The wall between the living room (6,1) and the kitchen (7,1): near the west edge of (7,1).
    const wall = await at(page, 7.08, 1.5);

    await rail.getByRole('button', { name: 'Door' }).click();
    await page.mouse.move(wall.x, wall.y);
    await expect(page.locator('.edit-edge')).toHaveAttribute('data-preview', 'door');
    await page.mouse.click(wall.x, wall.y);
    await saved(page);
    expect(kitchenWall(readHouse(dataDir))).toEqual({
      floorId: 'fl_0',
      x: 7,
      y: 1,
      side: 'w',
      kind: 'door',
    });
    await expect(page.locator('.plan .door')).toHaveCount(9);

    await page.keyboard.press('w'); // window tool
    await page.mouse.click(wall.x, wall.y);
    await saved(page);
    expect(kitchenWall(readHouse(dataDir))?.kind).toBe('window');

    await page.mouse.click(wall.x, wall.y); // same kind again: removed
    await saved(page);
    expect(kitchenWall(readHouse(dataDir))).toBeUndefined();

    // Inside the living room there is no wall.
    const inside = await at(page, 3.05, 2.5);
    const before = readFileSync(join(dataDir, 'house.json'), 'utf8');
    await page.mouse.move(inside.x, inside.y);
    await expect(page.locator('.edit-edge')).toHaveAttribute('data-preview', 'not-a-wall');
    await page.mouse.click(inside.x, inside.y);
    await expect(page.locator('.ed-notice').last()).toContainText('Doors and windows go on walls');
    expect(readFileSync(join(dataDir, 'house.json'), 'utf8')).toBe(before);

    // Undo brings back the window, then the door.
    await page.keyboard.press('Control+z');
    await saved(page);
    expect(kitchenWall(readHouse(dataDir))?.kind).toBe('window');
    await expectNoA11yViolations(page);
  });
});

test('#14: a room painted on a new floor and renamed says it is the same room on both floors', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  await startEditing(page, url);
  const rooms = sidebar(page).getByRole('region', { name: 'Rooms' });
  const notices = page.locator('.ed-notice');
  const livingRoom = rooms.locator('li[data-room="rm_liv"]');
  await expect(livingRoom.locator('.count')).toHaveText('36 tiles · Apartment');

  // What happened on real data: a new floor painted with the living room...
  await floors(page).getByRole('button', { name: '+ Floor above' }).click();
  await rooms.getByRole('button', { name: 'Paint with Living room' }).click();
  const box = (await page.locator('svg.plan').boundingBox())!;
  const v = await planView(page);
  await page.mouse.click(box.x + v.tx + 0.5 * 40 * v.k, box.y + v.ty + 0.5 * 40 * v.k);
  await expect(notices.last()).toContainText(
    'Living room is also on Apartment: these tiles are part of the same room.',
  );
  await expect(livingRoom.locator('.count')).toHaveText('37 tiles · Floor 1, Apartment');
  await expect(livingRoom.locator('.count')).toHaveClass(/shared/);

  // ... then renamed for the new floor: it says the Apartment's room changes too.
  const name = rooms.getByRole('textbox', { name: 'Name of Living room' });
  await name.fill('Terrace');
  await name.press('Enter');
  await expect(notices.last()).toContainText('Renamed to Terrace on Floor 1 and Apartment');
  await expectNoA11yViolations(page);

  // Undo, as the notice says: the Apartment's living room keeps its name.
  await page.keyboard.press('Control+z');
  await expect(rooms.getByRole('textbox', { name: 'Name of Living room' })).toBeVisible();
  await saved(page);
  const house = JSON.parse(readFileSync(join(dataDir, 'house.json'), 'utf8')) as {
    rooms: { id: string; name: string }[];
  };
  expect(house.rooms.find((r) => r.id === 'rm_liv')!.name).toBe('Living room');
});
