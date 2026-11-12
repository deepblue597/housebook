/**
 * Milestone 9, part 1: floor and wall finishes (D41) against the real backend: pick them in the
 * editor, see them with "Home look", undo, copy to other rooms, the outside walls. Part 2: the
 * textures (D42). Part 3: your own textures (D43).
 */
import { existsSync, readFileSync } from 'node:fs';
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

test('textures (D42): none fetched until the home look is on; then the room is filled with its pattern', async ({
  page,
  backend,
}) => {
  const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  // The kitchen gets the checker.
  const r = await page.request.get(`${url}/api/house`);
  const house = (await r.json()) as { rooms: Room[] };
  house.rooms.find((x) => x.id === 'rm_kit')!.floor = 'checker';
  await page.request.put(`${url}/api/house`, {
    data: house,
    headers: { 'If-Match': r.headers()['etag']! },
  });
  const fetched: string[] = [];
  page.on('request', (q) => {
    if (/\/assets\/[\w-]+\.jpg$/.test(new URL(q.url()).pathname)) fetched.push(q.url());
  });
  await gotoPlan(page, url);
  await page.waitForLoadState('networkidle');
  expect(fetched).toEqual([]);

  await page.getByRole('button', { name: 'Home look' }).click();
  const kitchen = page.locator('.plan .room[data-finish="checker"]');
  await expect(kitchen).toHaveAttribute('fill', 'url(#finish-checker)');
  const pattern = page.locator('pattern#finish-checker');
  // 1.2 m of checker per repeat, at 40 plan units per 1 m tile.
  await expect(pattern).toHaveAttribute('width', '48');
  await expect.poll(() => fetched.filter((u) => /checker/.test(u)).length).toBe(1);
  expect(fetched).toHaveLength(1); // only the finish in use
});

// A 2×2 PNG: the server decodes it, drops metadata and lists it in Textures/textures.json.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBNAOEBRUDAQCF1Bf9ayTWsgAAAABJRU5ErkJggg==',
  'base64',
);
const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'Textures', 'textures.json'), 'utf8')) as {
    textures: { key: string; label: string; kind: string; file: string; size: number[] }[];
  };

test('your own floor (D43): upload, use, see it in the home look, delete only when unused', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  await gotoPlan(page, url);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await sidebar(page).getByRole('button', { name: 'Finish of Kitchen' }).click();
  const dialog = finishDialog(page, 'Kitchen');

  await dialog.getByRole('button', { name: 'Add your own floor…' }).click();
  const form = dialog.getByRole('form', { name: 'Your own floor' });
  await form
    .getByLabel('Photo or scan (JPEG, PNG, WebP or HEIC)')
    .setInputFiles({ name: 'marble.png', mimeType: 'image/png', buffer: PNG });
  await expect(form.getByLabel('Name')).toHaveValue('marble'); // from the file name
  await form.getByLabel('Name').fill('Marble');
  await form.getByLabel('across (cm)').fill('60');
  await form.getByLabel('along (cm)').fill('30');
  await expectNoA11yViolations(page);
  await form.getByRole('button', { name: 'Add and use' }).click();

  // Added, and chosen for the kitchen.
  const swatch = dialog.getByRole('button', { name: 'Marble', exact: true });
  await expect(swatch).toHaveAttribute('aria-pressed', 'true');
  await saved(page);
  const [t] = manifest(dataDir).textures;
  expect(t).toMatchObject({ label: 'Marble', kind: 'floor', file: 'Marble.png', size: [0.6, 0.3] });
  expect(t!.key).toMatch(/^my_/);
  expect(existsSync(join(dataDir, 'Textures', 'Marble.png'))).toBe(true);
  expect(room(dataDir, 'rm_kit').floor).toBe(t!.key);

  // The plan fills the kitchen with it: 0.6 m per repeat at 40 plan units per 1 m tile.
  await dialog.getByRole('button', { name: 'Turn on Home look' }).click();
  const kitchen = page.locator(`.plan .room[data-finish="${t!.key}"]`);
  await expect(kitchen).toHaveAttribute('fill', `url(#finish-${t!.key})`);
  await expect(page.locator(`pattern#finish-${t!.key}`)).toHaveAttribute('width', '24');
  await expect(page.locator(`pattern#finish-${t!.key} image`)).toHaveAttribute(
    'href',
    new RegExp(`^/api/textures/${t!.key}\\?v=`),
  );

  // In use: not deleted.
  await dialog.getByRole('button', { name: 'Delete Marble' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByText('“Marble” is used by Kitchen')).toBeVisible();
  expect(manifest(dataDir).textures).toHaveLength(1);

  // Choose another floor, then delete it.
  await dialog.getByRole('button', { name: 'Oak', exact: true }).click();
  await saved(page);
  await dialog.getByRole('button', { name: 'Delete Marble' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(swatch).toHaveCount(0);
  expect(manifest(dataDir).textures).toEqual([]);
  expect(existsSync(join(dataDir, 'Textures', 'Marble.png'))).toBe(false);
});
