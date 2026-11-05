/**
 * Core journeys on examples/house. @smoke tests also run against the Docker image
 * (`pnpm e2e:docker`). More specific suites: plan, panel, search, data, ui.
 */
import {
  CHEST_FREEZER,
  DISHWASHER,
  expect,
  expectNoA11yViolations,
  floorTab,
  gotoPlan,
  item,
  panel,
  planItems,
  searchBox,
  test,
} from './support/fixtures';

test('loads the plan with floors, rooms, items and openings @smoke', async ({ page }) => {
  await gotoPlan(page);
  await expect(page.getByRole('group', { name: 'Floors' }).getByRole('button')).toHaveText([
    'Apartment',
    'Basement',
  ]);
  await expect(floorTab(page, 'Apartment')).toHaveAttribute('aria-pressed', 'true');
  await expect(planItems(page)).toHaveCount(13);
  await expect(page.getByRole('button', { name: 'Kitchen 16 m²', exact: true })).toBeVisible();
  await expect(page.locator('.plan .door')).toHaveCount(8);
  await expect(page.locator('.plan .window')).toHaveCount(6);
  // Every item is a labelled, focusable button.
  const attrs = await planItems(page).evaluateAll((els) =>
    els.map((e) => [
      e.getAttribute('role'),
      e.getAttribute('tabindex'),
      !!e.getAttribute('aria-label'),
    ]),
  );
  expect(new Set(attrs.map((a) => a.join()))).toEqual(new Set(['button,0,true']));
});

test('clicking the dishwasher shows its details and E15 quick help @smoke', async ({ page }) => {
  await gotoPlan(page);
  await item(page, DISHWASHER).click();
  await expect(page).toHaveURL(`/i/${DISHWASHER}`);
  await expect(item(page, DISHWASHER)).toHaveAttribute('aria-pressed', 'true');
  const details = panel(page);
  await expect(details.getByRole('heading', { level: 2, name: 'Dishwasher' })).toBeFocused();
  await expect(details.getByText('Kitchen · Apartment')).toBeVisible();
  await expect(details.getByText('Bosch · SMS4HVI33E')).toBeVisible();
  // Rendered Markdown (lazy chunk), not the plain-text fallback.
  await expect(details.getByRole('heading', { level: 3, name: 'Quick help' })).toBeVisible();
  await expect(details.locator('.md strong', { hasText: 'E15' })).toBeVisible();
  await expect(details.getByText('FD 0412 00123')).toBeVisible();
  await expect(details.getByRole('list', { name: 'Status' })).toBeVisible();
  await expect(details.getByRole('link', { name: 'Manual', exact: true })).toHaveAttribute(
    'href',
    'https://www.bosch-home.gr/',
  );
  await expect(details.getByRole('link', { name: 'Open in Obsidian' })).toHaveAttribute(
    'href',
    /^obsidian:\/\/open\?vault=homepage&file=Housebook%2FHouse%2FKitchen%2FDishwasher\.md$/,
  );
  await expect(details.getByText('House/Kitchen/Dishwasher.md')).toBeVisible();

  // Esc closes and returns focus to the item on the plan.
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(page).toHaveURL('/');
  await expect(item(page, DISHWASHER)).toBeFocused();
  await expect(item(page, DISHWASHER)).toHaveAttribute('aria-pressed', 'false');
});

test('clicking a room opens the room panel', async ({ page }) => {
  await gotoPlan(page);
  await page.getByRole('button', { name: 'Kitchen 16 m²', exact: true }).click();
  const details = panel(page);
  await expect(details.getByRole('heading', { name: 'Kitchen' })).toBeFocused();
  await expect(details.getByRole('listitem')).toHaveText([
    /Dishwasher/,
    /Fridge/,
    /Microwave/,
    /Oven/,
  ]);
  await expect(page).toHaveURL('/'); // rooms have no deep link
});

test('search for an error code highlights and opens the item @smoke', async ({ page }) => {
  await gotoPlan(page);
  await searchBox(page).fill('e15');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('Dishwasher');
  await expect(floorTab(page, 'Apartment').locator('.cnt')).toHaveText('1');
  await expect(floorTab(page, 'Basement').locator('.cnt')).toHaveCount(0); // no badge for 0
  await expect(item(page, DISHWASHER)).toHaveClass(/\bhit\b/);
  await expect(page.locator('.plan .badge.dim')).toHaveCount(12);
  await searchBox(page).press('Enter');
  await expect(page).toHaveURL(`/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
});

test('search folds Greek case and accents', async ({ page }) => {
  await gotoPlan(page);
  for (const q of ['θερμοσιφωνας', 'ΘΕΡΜΟΣΊΦΩΝΑΣ', 'θερμοσίφωνας', 'ΘΕΡΜΟΣΙΦΩΝΑΣ']) {
    await searchBox(page).fill(q);
    await expect(page.getByRole('option')).toHaveText([/^Water heater/]);
  }
  await searchBox(page).fill('nothing-like-this');
  await expect(page.getByText('Nothing matches “nothing-like-this”.')).toBeVisible();
});

test('opens the PDF attachment in the in-app viewer @smoke', async ({ page }) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await panel(page).getByRole('button', { name: 'View manual.pdf' }).click();
  const dialog = page.getByRole('dialog', { name: 'manual.pdf' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Page 1 of 1')).toBeVisible();
  // Something was painted on the canvas.
  await expect
    .poll(() =>
      dialog.getByTestId('pdf-canvas').evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
        return dark;
      }),
    )
    .toBeGreaterThan(50);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(panel(page)).toBeVisible(); // Esc in the dialog doesn't close the panel too
});

test('deep link /i/<id> opens the item on its own floor; history follows @smoke', async ({
  page,
}) => {
  await gotoPlan(page, `/i/${CHEST_FREEZER}`);
  await expect(panel(page).getByRole('heading', { name: 'Chest freezer' })).toBeVisible();
  await expect(floorTab(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
  await expect(item(page, CHEST_FREEZER)).toHaveClass(/\bsel\b/);

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/');
  await page.goBack();
  await expect(page).toHaveURL(`/i/${CHEST_FREEZER}`);
  await expect(panel(page).getByRole('heading', { name: 'Chest freezer' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL('/');
  await expect(panel(page)).toBeHidden();

  // Trailing slash and a URL-encoded id work too.
  await page.goto(`/i/${encodeURIComponent(DISHWASHER)}/`);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
});

test('unknown deep link shows a not-found panel over a working plan @smoke', async ({ page }) => {
  await gotoPlan(page, '/i/it_nope00');
  const d = panel(page);
  await expect(d.getByRole('heading', { name: 'Item not found' })).toBeFocused();
  await expect(d.getByText('it_nope00')).toBeVisible();
  await expect(planItems(page)).toHaveCount(13);
  await d.getByRole('button', { name: 'Close details' }).click();
  await expect(d).toBeHidden();
  await expect(page).toHaveURL('/');
});

test('plan items are reachable with Tab and operable with Enter', async ({ page }) => {
  await gotoPlan(page);
  await page.getByRole('region', { name: /^Plan of Apartment/ }).focus();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await item(page, DISHWASHER).evaluate((el) => el === document.activeElement);
  }
  expect(reached, 'Tab never reached the dishwasher').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/i/${DISHWASHER}`);
});

test('plan view has no axe violations', async ({ page }) => {
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  await expectNoA11yViolations(page);
  await item(page, DISHWASHER).click();
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Quick help' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('list view has no axe violations', async ({ page }) => {
  await gotoPlan(page);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Items by floor and room' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('phone: bottom sheet details, no horizontal scroll @phone', async ({ page }) => {
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  await item(page, DISHWASHER).tap();
  const details = panel(page);
  await expect(details.getByRole('heading', { level: 3, name: 'Quick help' })).toBeVisible();
  const viewport = page.viewportSize()!;
  // Anchored to the bottom (poll: the sheet slides in).
  await expect
    .poll(async () => {
      const b = (await details.boundingBox())!;
      return Math.round(b.y + b.height);
    })
    .toBe(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport.width,
  );
  await expectNoA11yViolations(page);
  await page.getByRole('button', { name: 'Close details' }).tap();
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'List', exact: true }).tap();
  await expect(page.getByRole('region', { name: 'Items by floor and room' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport.width,
  );
  await expectNoA11yViolations(page);
});
