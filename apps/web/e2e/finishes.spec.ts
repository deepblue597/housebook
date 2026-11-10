/**
 * Milestone 9, part 1: floor and wall finishes (D41) against the real backend: pick them in the
 * editor, see them with "Home look", undo, copy to other rooms, the outside walls.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectNoA11yViolations, gotoPlan, test } from './support/fixtures';

interface Room {
  id: string;
  name: string;
  floor?: string;
  walls?: string;
}
const readHouse = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'house.json'), 'utf8')) as {
    schemaVersion: number;
    rooms: Room[];
    exteriorWallColor?: string;
  };
const room = (dir: string, id: string) => readHouse(dir).rooms.find((r) => r.id === id)!;
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Editor' });
const finishDialog = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Finish of ${name}` });
async function saved(page: Page) {
  await expect(page.locator('[data-save]')).toHaveAttribute('data-save', 'saved', {
    timeout: 10_000,
  });
}

test('pick a floor and walls, see them in the home look, undo, copy to other rooms', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  await gotoPlan(page, url);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await sidebar(page).getByRole('button', { name: 'Finish of Kitchen' }).click();
  const dialog = finishDialog(page, 'Kitchen');

  await dialog.getByRole('button', { name: 'White tiles' }).click();
  await dialog.getByRole('button', { name: 'Sage' }).click();
  await expect(dialog.getByRole('button', { name: 'White tiles' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await saved(page);
  expect(readHouse(dataDir).schemaVersion).toBe(2);
  expect(room(dataDir, 'rm_kit')).toMatchObject({ floor: 'tiles_white', walls: '#b7c2a6' });
  await expectNoA11yViolations(page);

  // The dialog offers the home look; the 2D plan then fills the kitchen with its finish.
  await dialog.getByRole('button', { name: 'Turn on Home look' }).click();
  await expect(page.getByRole('button', { name: 'Home look' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.plan .room[data-finish="tiles_white"]')).toHaveCount(1);

  // Copy to the bedroom and the hallway: one step.
  await dialog.getByRole('checkbox', { name: 'Bedroom' }).check();
  await dialog.getByRole('checkbox', { name: 'Hallway' }).check();
  await dialog.getByRole('button', { name: 'Copy to 2 rooms' }).click();
  await saved(page);
  for (const id of ['rm_bed', 'rm_hal'])
    expect(room(dataDir, id)).toMatchObject({ floor: 'tiles_white', walls: '#b7c2a6' });

  // Outside walls.
  await dialog.getByLabel('Outside walls (whole house)').fill('#333333');
  await saved(page);
  expect(readHouse(dataDir).exteriorWallColor).toBe('#333333');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Undo three times: outside walls, the copy (both rooms at once), then the walls.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await saved(page);
  const h = readHouse(dataDir);
  expect(h.exteriorWallColor).toBeUndefined();
  expect(h.rooms.find((r) => r.id === 'rm_bed')).not.toHaveProperty('floor');
  expect(h.rooms.find((r) => r.id === 'rm_kit')).toMatchObject({ floor: 'tiles_white' });
  expect(h.rooms.find((r) => r.id === 'rm_kit')).not.toHaveProperty('walls');
});

test('the home look is a per-browser setting, off by default; plan colours stay for finding things', async ({
  page,
}) => {
  await gotoPlan(page);
  const toggle = page.getByRole('button', { name: 'Home look' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Home look' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
