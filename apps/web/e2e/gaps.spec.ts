/**
 * Prototype parity and spec gaps closed after the first test pass: "Find manual online",
 * "Copy path", heading wikilinks, protocol-relative links, zero match counts, two-finger pan.
 */
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  expect,
  floorTab,
  gotoPlan,
  panel,
  planView,
  searchBox,
  test,
} from './support/fixtures';

test('"Find manual online" searches for brand, model and "manual pdf" in a new tab', async ({
  page,
}) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  const link = panel(page).getByRole('link', { name: 'Find manual online' });
  await expect(link).toHaveAttribute(
    'href',
    `https://www.google.com/search?q=${encodeURIComponent('Bosch SMS4HVI33E manual pdf')}`,
  );
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('"Copy path" copies the note path, and selects it when the clipboard is refused', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoPlan(page, `/i/${DISHWASHER}`);
  const button = panel(page).getByRole('button', { name: 'Copy path' });
  const status = panel(page).locator('.copy-status');
  await button.click();
  await expect(status).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'House/Kitchen/Dishwasher.md',
  );

  // Fallback: no Clipboard API (e.g. plain http on the LAN) -> the path is selected instead.
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }),
  );
  await expect(status).toHaveText('', { timeout: 4_000 });
  await button.click();
  await expect(status).toHaveText(/Selected/);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'House/Kitchen/Dishwasher.md',
  );
});

const NOTE = `---
housebook_id: it_links1
type: other
name: Link test
tags: [housebook]
---
See [[Dishwasher#Quick help]] and [[Nowhere#Somewhere]], or [the shop](//shop.example/manual).
`;

test('heading wikilinks read "Note › Heading"; protocol-relative links leave the app safely', async ({
  page,
  backend,
}) => {
  const { url } = await backend({ files: { 'House/Kitchen/Link test.md': NOTE } });
  await page.goto(`${url}/i/it_links1`);
  const md = panel(page).locator('.md');
  const toItem = md.getByRole('link', { name: 'Dishwasher › Quick help' });
  await expect(toItem).toHaveAttribute('href', `/i/${DISHWASHER}`);
  await expect(md.getByText('Nowhere › Somewhere')).toBeVisible();
  await expect(md.getByRole('link', { name: 'Nowhere › Somewhere' })).toHaveCount(0);

  const shop = md.getByRole('link', { name: 'the shop' });
  await expect(shop).toHaveAttribute('href', '//shop.example/manual');
  await expect(shop).toHaveAttribute('target', '_blank');
  await expect(shop).toHaveAttribute('rel', 'noopener noreferrer');

  await toItem.click();
  await expect(page).toHaveURL(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
});

test('floor tabs show a match count only where there are matches', async ({ page }) => {
  await gotoPlan(page);
  await searchBox(page).fill('chest freezer');
  await expect(floorTab(page, 'Basement').locator('.cnt')).toHaveText('1');
  await expect(floorTab(page, 'Apartment').locator('.cnt')).toHaveCount(0);
  await expect(floorTab(page, 'Basement')).toHaveAccessibleName('Basement, 1 match');
});

test.describe('touch @phone', () => {
  async function touch(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    return (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
  }

  test('two fingers moving together pan the plan without zooming', async ({ page }) => {
    await gotoPlan(page);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const vp = (await page.locator('.viewport').boundingBox())!;
    const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
    const send = await touch(page);
    const before = await planView(page);
    await send('touchStart', [
      { x: c.x - 40, y: c.y },
      { x: c.x + 40, y: c.y },
    ]);
    for (let i = 1; i <= 5; i++) {
      await send('touchMove', [
        { x: c.x - 40 + 8 * i, y: c.y + 4 * i },
        { x: c.x + 40 + 8 * i, y: c.y + 4 * i },
      ]);
    }
    await send('touchEnd', []);
    await expect.poll(async () => (await planView(page)).tx - before.tx).toBeCloseTo(40, 0);
    const after = await planView(page);
    expect(after.ty - before.ty).toBeCloseTo(20, 0);
    expect(after.k).toBeCloseTo(before.k, 6);
    await expect(panel(page)).toBeHidden(); // no tap fired
  });
});
