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
  test,
} from './support/fixtures';

interface House {
  floors: { id: string; name: string; level: number; cells: Record<string, string> }[];
  placements: { itemId: string; floorId: string }[];
  openings: { floorId: string }[];
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
