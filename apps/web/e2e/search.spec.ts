/**
 * Client-side search (D9): results, ranking parity with the backend's `GET /api/items?q=` (same
 * contract), plan highlighting and dimming, per-floor counts, keyboard, no results, clearing.
 */
import type { Page } from '@playwright/test';
import {
  CHEST_FREEZER,
  DISHWASHER,
  expect,
  floorTab,
  gotoPlan,
  item,
  panel,
  planItems,
  searchBox,
  test,
} from './support/fixtures';

const options = (page: Page) =>
  page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
const count = (page: Page, floor: string) => floorTab(page, floor).locator('.cnt');

async function apiSearch(page: Page, q: string): Promise<string[]> {
  const res = await page.request.get(`/api/items?q=${encodeURIComponent(q)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
}

async function hitsOnPlan(page: Page) {
  return planItems(page).evaluateAll((els) =>
    els.filter((e) => e.classList.contains('hit')).map((e) => e.getAttribute('data-item-id')),
  );
}

for (const q of ['e15', 'ac', 'bosch', 'θερμοσιφωνας', 'kitchen', 'SMS4HV']) {
  test(`"${q}": same results and order as the backend`, async ({ page }) => {
    await gotoPlan(page);
    const expected = await apiSearch(page, q);
    await searchBox(page).fill(q);
    await expect(options(page)).toHaveCount(Math.min(expected.length, 8));
    const shown = await options(page).evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    const names = await Promise.all(
      expected.slice(0, 8).map(async (id) => {
        const r = await page.request.get(`/api/items/${id}`);
        return ((await r.json()) as { name: string }).name;
      }),
    );
    expect(shown.map((t, i) => t.startsWith(names[i]!))).toEqual(names.map(() => true));
    // Apartment hits on the plan are the backend's hits on that floor.
    const all = new Set(expected);
    const onPlan = await planItems(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-item-id') ?? ''),
    );
    expect((await hitsOnPlan(page)).sort()).toEqual(onPlan.filter((id) => all.has(id)).sort());
  });
}

test('matches are highlighted, everything else dimmed, with per-floor counts', async ({ page }) => {
  await gotoPlan(page);
  await expect(count(page, 'Apartment')).toHaveCount(0); // no counts without a query
  await searchBox(page).fill('e15');
  await expect(options(page)).toHaveText([/^Dishwasher/]);
  await expect(count(page, 'Apartment')).toHaveText('1');
  await expect(count(page, 'Basement')).toHaveCount(0); // no badge for 0
  await expect(item(page, DISHWASHER)).toHaveClass(/\bhit\b/);
  await expect(page.locator('.plan .badge.dim')).toHaveCount(12);
  await expect(page.locator('.plan .iname.dim')).toHaveCount(12);
  await expect(page.getByRole('status').filter({ hasText: /result/ })).toHaveText('1 result');

  // A match on another floor: counted there, everything here dimmed.
  await searchBox(page).fill('chest freezer');
  await expect(count(page, 'Basement')).toHaveText('1');
  await expect(count(page, 'Apartment')).toHaveCount(0); // no badge for 0
  await expect(page.locator('.plan .badge.dim')).toHaveCount(13);
  await floorTab(page, 'Basement').click();
  await expect(item(page, CHEST_FREEZER)).toHaveClass(/\bhit\b/);
});

test('no results: message, zero counts, list says so too', async ({ page }) => {
  await gotoPlan(page);
  await searchBox(page).fill('zzz-nothing');
  await expect(page.getByText('Nothing matches “zzz-nothing”.')).toBeVisible();
  await expect(options(page)).toHaveCount(0);
  await expect(count(page, 'Apartment')).toHaveCount(0); // no badge for 0
  await expect(page.locator('.plan .badge.dim')).toHaveCount(13);
  await searchBox(page).press('Enter'); // nothing to open
  await expect(panel(page)).toBeHidden();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByText('No items match the search.')).toBeVisible();
  await expect(page.locator('.list-view [data-item-id]')).toHaveCount(0);
});

test('clearing the search restores the plan', async ({ page }) => {
  await gotoPlan(page);
  await searchBox(page).fill('e15');
  await expect(page.locator('.plan .badge.dim')).toHaveCount(12);
  await searchBox(page).fill('');
  await expect(page.locator('.plan .badge.dim, .plan .badge.hit, .plan .iname.dim')).toHaveCount(0);
  await expect(count(page, 'Apartment')).toHaveCount(0);
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeHidden();
  // Whitespace only is not a search.
  await searchBox(page).fill('   ');
  await expect(page.locator('.plan .badge.dim')).toHaveCount(0);
});

test('Enter opens the top result, arrows pick another, the floor follows', async ({ page }) => {
  await gotoPlan(page);
  await searchBox(page).fill('ac');
  await expect(options(page).first()).toBeVisible();
  // The option's name is the first text node; the <small> under it is room · floor · model.
  const first = await options(page)
    .first()
    .evaluate((o) => o.querySelector('span')!.firstChild!.textContent!.trim());
  await searchBox(page).press('Enter');
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText(first);
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeHidden();

  // ArrowDown moves to the next option, ArrowUp back (wrapping).
  await searchBox(page).fill('freezer');
  await expect(options(page).first()).toBeVisible();
  const n = await options(page).count();
  await searchBox(page).press('ArrowDown');
  await expect(options(page).nth(1 % n)).toHaveAttribute('aria-selected', 'true');
  await expect(searchBox(page)).toHaveAttribute(
    'aria-activedescendant',
    (await options(page)
      .nth(1 % n)
      .getAttribute('id'))!,
  );
  await searchBox(page).press('ArrowUp');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');

  // Picking the basement freezer switches the plan to the Basement.
  await options(page).filter({ hasText: 'Chest freezer' }).click();
  await expect(page).toHaveURL(`/i/${CHEST_FREEZER}`);
  await expect(floorTab(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
  await expect(item(page, CHEST_FREEZER)).toHaveClass(/\bsel\b/);
});

test('more than eight matches: the rest are counted and still highlighted', async ({ page }) => {
  await gotoPlan(page);
  const expected = await apiSearch(page, 'e');
  test.skip(expected.length <= 8, 'fixture has too few matches for "e"');
  await searchBox(page).fill('e');
  await expect(options(page)).toHaveCount(8);
  await expect(
    page.getByText(`${expected.length - 8} more highlighted on the plan.`),
  ).toBeVisible();
});
