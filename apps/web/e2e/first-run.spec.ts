/**
 * Milestone 6: first run (DESIGN 15.16, D34). An empty data folder offers editors to create the
 * floor plan; an unreadable house.json is never replaced from the app.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectNoA11yViolations, planView, test } from './support/fixtures';

const S = 40; // plan units per tile (features/plan2d/geometry.ts)
const card = (page: Page) => page.getByRole('region', { name: 'Set up your house' });
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Editor' });

interface House {
  grid: { width: number; depth: number; tileSize: number };
  rooms: { id: string; name: string }[];
  floors: { id: string; name: string; level: number; cells: Record<string, string> }[];
}
const readHouse = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'house.json'), 'utf8')) as House;

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

test.describe('first run', () => {
  test('an editor creates the floor plan and paints the first room', async ({ page, backend }) => {
    const { url, dataDir } = await backend(
      { fromExample: false },
      { HOUSEBOOK_ANON_ROLE: 'editor' },
    );
    await page.goto(url);
    await expect(card(page)).toBeVisible();
    await expectNoA11yViolations(page);

    await card(page).getByLabel('Width (east–west), m').fill('0');
    await card(page).getByRole('button', { name: 'Create the floor plan' }).click();
    await expect(card(page).getByRole('status')).toContainText('1 to 512 metres');
    expect(existsSync(join(dataDir, 'house.json'))).toBe(false);

    await card(page).getByLabel('Name of this floor').fill('Apartment');
    await card(page).getByLabel('Width (east–west), m').fill('12');
    await card(page).getByLabel('Depth (north–south), m').fill('8');
    await expect(card(page)).toContainText('12 × 8 tiles of 1 m (96 m²)');
    await card(page).getByRole('button', { name: 'Create the floor plan' }).click();

    // The editor opens with "Room 1" ready to paint.
    await expect(sidebar(page)).toBeVisible();
    await expect(page.locator('svg.plan')).toBeVisible();
    const created = readHouse(dataDir);
    expect(created.grid).toEqual({ tileSize: 1, width: 12, depth: 8 });
    expect(created.floors).toHaveLength(1);
    expect(created.floors[0]).toMatchObject({ name: 'Apartment', level: 0 });

    await drag(page, await cell2d(page, 1, 1), await cell2d(page, 4, 3));
    await expect(page.locator('[data-save]')).toHaveAttribute('data-save', 'saved', {
      timeout: 10_000,
    });
    const painted = readHouse(dataDir);
    expect(painted.rooms.map((r) => r.name)).toEqual(['Room 1']);
    expect(Object.keys(painted.floors[0]!.cells)).toHaveLength(12);
    await expect(page.getByRole('button', { name: 'Set up your house' })).toHaveCount(0);
  });

  test('existing notes are counted and wait in the Unplaced tray', async ({ page, backend }) => {
    const { url } = await backend(
      {
        fromExample: false,
        files: {
          'House/Kitchen/Fridge.md':
            '---\nhousebook_id: it_fr1dge\ntype: fridge\nname: Fridge\ntags: [housebook]\n---\n',
        },
      },
      { HOUSEBOOK_ANON_ROLE: 'editor' },
    );
    await page.goto(url);
    await expect(card(page)).toContainText('1 item was found in your notes');
    await card(page).getByRole('button', { name: 'Create the floor plan' }).click();
    await expect(sidebar(page)).toBeVisible();
    await expect(sidebar(page).locator('[data-unplaced-id="it_fr1dge"]')).toBeVisible();
  });

  test('tagged notes without an id are counted, with where to adopt them', async ({
    page,
    backend,
  }) => {
    const { url } = await backend(
      {
        fromExample: false,
        files: {
          'House/Kitchen/Kettle.md': '---\ntype: other\nname: Kettle\ntags: [housebook]\n---\n',
        },
      },
      { HOUSEBOOK_ANON_ROLE: 'editor' },
    );
    await page.goto(url);
    await expect(card(page)).toContainText(
      '1 note is tagged housebook but not part of Housebook yet',
    );
    await expect(card(page)).not.toContainText('found in your notes');
  });

  test('viewers are told someone who can edit can set it up', async ({ page, backend }) => {
    const { url } = await backend({ fromExample: false });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'No floor plan yet' })).toBeVisible();
    await expect(page.getByText(/Someone who can edit it can set it up/)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('an unreadable house.json is never replaced from here', async ({ page, backend }) => {
    const { url, dataDir } = await backend(
      { house: '{ "schemaVersion": 1, "grid": ' },
      { HOUSEBOOK_ANON_ROLE: 'editor' },
    );
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'No floor plan yet' })).toBeVisible();
    await expect(page.getByText(/There is no valid/)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(readFileSync(join(dataDir, 'house.json'), 'utf8')).toBe(
      '{ "schemaVersion": 1, "grid": ',
    );
  });
});
