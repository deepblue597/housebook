import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Page, test as base, expect } from '@playwright/test';
import { type Backend, type DataRootSpec, EXAMPLE, makeDataRoot, startBackend } from './server';

export { expect };

// Ids from examples/house.
export const DISHWASHER = 'it_7f3k2a';
export const FRIDGE = 'it_4f8k2q';
export const CHEST_FREEZER = 'it_9p2x5c'; // the only item on the Basement floor
export const WATER_HEATER = 'it_1w7e3h';

export const item = (page: Page, id: string) => page.locator(`.plan [data-item-id="${id}"]`);
export const panel = (page: Page) => page.getByRole('complementary', { name: 'Details' });
export const searchBox = (page: Page) => page.getByRole('combobox', { name: /search/i });
export const floorTab = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Floors' }).getByRole('button', { name: new RegExp(`^${name}`) });
export const planItems = (page: Page) => page.locator('.plan [data-item-id]');

/** examples/house/house.json, for expectations derived from the fixture itself. */
export interface HouseJson {
  grid: { width: number; depth: number; tileSize: number };
  rooms: { id: string; name: string; color: string }[];
  floors: { id: string; name: string; level: number; cells: Record<string, string> }[];
  placements: { itemId: string; floorId: string; x: number; y: number }[];
  openings?: { floorId: string; x: number; y: number; side: 'n' | 'w'; kind: string }[];
}
export const exampleHouse = (): HouseJson =>
  JSON.parse(readFileSync(join(EXAMPLE, 'house.json'), 'utf8')) as HouseJson;

export async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** The plan's current transform: translate(tx ty) scale(k). */
export async function planView(page: Page) {
  const t = await page.locator('.plan > g').getAttribute('transform');
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(t ?? '');
  if (!m) throw new Error(`unexpected transform: ${t}`);
  return { tx: Number(m[1]), ty: Number(m[2]), k: Number(m[3]) };
}

/** Wait until the app has rendered the plan for the first floor. */
export async function gotoPlan(page: Page, url = '/') {
  await page.goto(url);
  await expect(page.locator('.plan')).toBeVisible();
}

interface Fixtures {
  /**
   * Start a private backend on a crafted data root (a copy of examples/house plus `spec`).
   * Stopped and deleted after the test.
   */
  backend: (spec?: DataRootSpec, env?: Record<string, string>) => Promise<Backend>;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  backend: async ({}, provide) => {
    const started: { dir: string; stop?: () => Promise<void> }[] = [];
    await provide(async (spec = {}, env = {}) => {
      const dataDir = makeDataRoot(spec);
      const entry: { dir: string; stop?: () => Promise<void> } = { dir: dataDir };
      started.push(entry);
      const { url, stop } = await startBackend(dataDir, env);
      entry.stop = stop;
      return { url, dataDir, stop };
    });
    for (const { dir, stop } of started) {
      await stop?.();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
