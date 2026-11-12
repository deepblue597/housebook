/**
 * The attention list (milestone 8, D38) against the real backend and the example house, on a
 * fixed day so the statuses are known: 26 Apr 2027 has overdue, due-soon and warranty-ending
 * items (the client recomputes for its own date).
 */
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  expect,
  expectNoA11yViolations,
  gotoPlan,
  openMore,
  panel,
  planItems,
  searchBox,
  test,
} from './support/fixtures';

const DAY = new Date('2027-04-26T10:00:00+03:00');
const views = (page: Page) => page.getByRole('group', { name: 'View' });
const attention = (page: Page) => page.getByRole('region', { name: 'What needs attention' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(DAY);
});

test('the switch counts the items listed; overdue first; an entry opens its item @smoke', async ({
  page,
}) => {
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  // The switch counts the items of the whole house, not just this floor.
  const button = views(page).getByRole('button', { name: /^Attention \d+$/ });
  const count = Number(/\d+/.exec((await button.textContent()) ?? '')![0]);
  expect(count).toBeGreaterThan(0);
  await button.click();
  await expect(attention(page)).toBeVisible();

  // Overdue first, then coming up; every entry says what is due in words.
  const overdue = attention(page).getByRole('region', { name: /Overdue/ });
  const upcoming = attention(page).getByRole('region', { name: /Coming up/ });
  await expect(overdue.getByRole('button').first()).toContainText(/Check overdue by \d+ days?/);
  await expect(upcoming.getByRole('button').first()).toContainText(/(Check due|Warranty ends)/);
  // Distinct items listed = the count (an item can have two entries).
  const ids = await attention(page)
    .locator('[data-item-id]')
    .evaluateAll((els) => new Set(els.map((e) => e.getAttribute('data-item-id'))).size);
  expect(ids).toBe(count);

  // The dishwasher's warranty ends 10 May 2027: two weeks away.
  const dish = upcoming.locator(`[data-item-id="${DISHWASHER}"][data-kind="warranty_ending"]`);
  await expect(dish).toContainText('Warranty ends in 14 days');
  await dish.click();
  await expect(panel(page)).toContainText('Dishwasher');
  await expect(page).toHaveURL(new RegExp(`/i/${DISHWASHER}$`));
  await expectNoA11yViolations(page);
});

test('the view is remembered, and follows the search', async ({ page }) => {
  await gotoPlan(page);
  await views(page)
    .getByRole('button', { name: /^Attention/ })
    .click();
  await page.reload();
  await expect(attention(page)).toBeVisible();
  await searchBox(page).fill('dishwasher');
  await expect(attention(page).getByRole('status')).toContainText('match the search');
  const listed = await attention(page)
    .locator('[data-item-id]')
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-item-id')))]);
  expect(listed).toEqual([DISHWASHER]);
});

test('on a phone: no horizontal scroll, entries keep 44 px targets @phone', async ({ page }) => {
  await gotoPlan(page);
  await views(page)
    .getByRole('button', { name: /^Attention/ })
    .click();
  await expect(attention(page)).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
  for (const b of await attention(page).getByRole('button').all())
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('calendar link (D40): a viewer makes one; the feed has the dates; a new link replaces it', async ({
  page,
  backend,
}) => {
  const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'viewer' });
  await page.goto(url);
  await views(page)
    .getByRole('button', { name: /^Attention/ })
    .click();
  await (await openMore(page)).getByRole('button', { name: 'Add to your calendar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to your calendar' });
  await dialog.getByRole('button', { name: 'Make my calendar link' }).click();
  const link = await dialog.getByLabel('Calendar link').inputValue();
  expect(link).toMatch(new RegExp(`^${url}/api/calendar.ics\\?token=[\\w-]{40,}$`));
  await expectNoA11yViolations(page);

  // What a calendar app gets: no cookies, no login.
  const feed = await page.request.get(link);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  const ics = (await feed.text()).replace(/\r\n /g, '');
  expect(ics).toContain('SUMMARY:Warranty ends: Dishwasher');
  expect(ics).toContain('DTSTART;VALUE=DATE:20270510');
  expect(ics).toContain(`URL:${url}/i/${DISHWASHER}`);

  // Reopened: the link isn't shown again; a new one replaces it.
  await dialog.getByRole('button', { name: 'Close' }).click();
  // Focus goes back to the menu button the dialog was opened from.
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused();
  await (await openMore(page)).getByRole('button', { name: 'Add to your calendar' }).click();
  await expect(dialog).toContainText('It can’t be shown again');
  await dialog.getByRole('button', { name: 'Make a new link' }).click();
  const newer = await dialog.getByLabel('Calendar link').inputValue();
  expect(newer).not.toBe(link);
  expect((await page.request.get(link)).status()).toBe(404);
  expect((await page.request.get(newer)).status()).toBe(200);
});
