/**
 * Milestone 12: QR stickers (D45): choose items, a size, print. Each code links to the item's
 * deep link (/i/<id>, D16), which opens the item.
 */
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  expect,
  expectNoA11yViolations,
  gotoPlan,
  panel,
  test,
} from './support/fixtures';

const stickers = (page: Page) => page.locator('.qs-sticker');

test('every item by default; narrow down, pick a size, print', async ({ page }) => {
  await gotoPlan(page);
  await page.getByRole('button', { name: 'List' }).click();
  await page.getByRole('link', { name: 'QR stickers' }).click();
  await expect(page).toHaveURL(/\/print\/stickers$/);
  await expect(page).toHaveTitle('QR stickers · Housebook');
  await expect(stickers(page)).toHaveCount(14); // every example item
  await expect(page.getByText('14 stickers selected')).toBeVisible();

  const dish = page.locator(`.qs-sticker[data-item-id="${DISHWASHER}"]`);
  await expect(dish).toContainText('Dishwasher');
  await expect(dish).toContainText('Kitchen · Apartment');
  await expect(dish.locator('code')).toHaveText(`/i/${DISHWASHER}`);
  const origin = new URL(page.url()).origin;
  await expect(dish.getByRole('img', { name: 'QR code for Dishwasher' })).toHaveAttribute(
    'data-url',
    `${origin}/i/${DISHWASHER}`,
  );
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Emergency items' }).click();
  await expect(stickers(page)).toHaveCount(3);
  await page.getByRole('checkbox', { name: /^Router/ }).uncheck();
  await expect(stickers(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'None' }).click();
  await expect(stickers(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeDisabled();
  await page.getByRole('button', { name: 'All' }).click();
  await expect(stickers(page)).toHaveCount(14);

  // Large: 5 cm codes. On paper the chooser is hidden; a PDF comes out.
  await page.getByRole('radio', { name: /^Large/ }).check();
  const code = dish.locator('.qs-code');
  const small = await code.boundingBox();
  expect(small!.width).toBeGreaterThan(180); // 50 mm ≈ 189 px at 96 dpi
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.paper-toolbar')).toBeHidden();
  const pdf = await page.pdf({ format: 'A4' });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
});

test('one item from its panel; the sticker’s link opens it', async ({ page }) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await panel(page).getByRole('link', { name: 'QR sticker' }).click();
  await expect(page).toHaveURL(new RegExp(`/print/stickers\\?items=${DISHWASHER}$`));
  await expect(stickers(page)).toHaveCount(1);
  const url = await page.locator('.qs-code').getAttribute('data-url');
  await page.goto(url!);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
});

test('the List view’s search narrows the stickers', async ({ page }) => {
  await gotoPlan(page);
  await page.getByRole('button', { name: 'List' }).click();
  await page.getByRole('combobox', { name: /search/i }).fill('fridge');
  await page.getByRole('link', { name: 'QR stickers' }).click();
  await expect(stickers(page)).toHaveCount(2); // the fridge and the chest freezer
});

test('stickers fit a phone screen @phone', async ({ page }) => {
  await page.goto('/print/stickers');
  await expect(stickers(page)).toHaveCount(14);
  const overflow = await page
    .locator('.paper-page')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
