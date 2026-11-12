/**
 * Milestone 12: the printable emergency sheet (D44) against the real backend: what it shows,
 * how it prints, and the reminder to reprint it when the house changes.
 */
import { expect, expectNoA11yViolations, gotoPlan, test } from './support/fixtures';

const VALVE = 'it_2v9q6t';
const FUSE_BOX = 'it_7n3d8f';
const ROUTER = 'it_8r2w6z';

test('the sheet shows each emergency item on its floor plan, with where it is and what to do', async ({
  page,
}) => {
  await gotoPlan(page);
  await page.getByRole('button', { name: 'Attention' }).click();
  await page.getByRole('link', { name: 'Emergency sheet' }).click();
  await expect(page).toHaveURL(/\/print\/emergency$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Emergency sheet' })).toBeVisible();
  await expect(page).toHaveTitle('Emergency sheet · Housebook');

  // The example's emergency items: valve, fuse box, router (catalogue defaults), numbered 1..3.
  const entries = page.locator('.es-item');
  await expect(entries).toHaveCount(3);
  for (const id of [VALVE, FUSE_BOX, ROUTER]) {
    await expect(page.locator(`.es-item[data-item-id="${id}"]`)).toHaveCount(1);
    await expect(page.locator(`.es-plan [data-item-id="${id}"]`)).toHaveCount(1);
  }
  const valve = page.locator(`.es-item[data-item-id="${VALVE}"]`);
  await expect(valve.getByRole('heading', { name: /Main water valve/ })).toBeVisible();
  await expect(valve).toContainText('Utility, Apartment');
  await expect(valve).toContainText('Turn clockwise to close'); // the note has no Quick help: all of it
  const router = page.locator(`.es-item[data-item-id="${ROUTER}"]`);
  await expect(router).toContainText('Make and model: TP-Link Archer AX55');
  await expect(router).toContainText('unplug for 30 s'); // its Quick help section
  await expect(page.locator(`.es-item[data-item-id="${FUSE_BOX}"]`)).toContainText('B3 Oven');
  // Marker numbers match the list.
  const n = await valve.locator('.es-n').textContent();
  await expect(page.locator(`.es-plan [data-item-id="${VALVE}"] text`)).toHaveText(n!);
  await expect(page.locator('[data-version]')).toHaveText(/^Printed .+ · version [0-9a-f]{8}$/);
  await expectNoA11yViolations(page);

  // On paper: no buttons, light background; a PDF comes out.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.es-toolbar')).toBeHidden();
  const pdf = await page.pdf({ format: 'A4' });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
});

test('dark theme or not, the sheet is light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/print/emergency');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bg = await page.locator('.es-page').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(0, 0, 0)');
});

test('after printing, a change to the sheet is flagged in the Attention view until it is reprinted', async ({
  page,
  backend,
}) => {
  const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  await page.goto(`${url}/print/emergency`);
  await expect(page.locator('.es-item')).toHaveCount(3);

  // The print dialog closed (the browser's afterprint): say it printed.
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.getByRole('button', { name: 'Yes, remember this version' }).click();
  await expect(page.locator('[data-printed]')).toHaveAttribute('data-printed', 'current');

  // Still current: no reminder.
  await gotoPlan(page, url);
  await page.getByRole('button', { name: 'Attention' }).click();
  await expect(page.locator('.attention-reprint')).toHaveCount(0);

  // Rename the valve: what is printed is out of date.
  const r = await page.request.get(`${url}/api/items/${VALVE}`);
  const patched = await page.request.patch(`${url}/api/items/${VALVE}`, {
    data: { frontmatter: { name: 'Water stopcock' } },
    headers: { 'If-Match': r.headers()['etag']! },
  });
  expect(patched.status()).toBe(200);
  await expect(page.locator('.attention-reprint')).toContainText('The emergency sheet printed on');
  await page.locator('.attention-reprint').getByRole('link', { name: 'Print it again' }).click();
  await expect(page.locator('[data-printed]')).toHaveAttribute('data-printed', 'old');
  await expect(page.locator(`.es-item[data-item-id="${VALVE}"]`)).toContainText('Water stopcock');

  // "No" after a print remembers nothing.
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.getByRole('button', { name: 'No', exact: true }).click();
  await expect(page.locator('[data-printed]')).toHaveAttribute('data-printed', 'old');
});

test('the sheet fits a phone and stays readable @phone', async ({ page }) => {
  await page.goto('/print/emergency');
  await expect(page.locator('.es-item')).toHaveCount(3);
  const overflow = await page.locator('.es-page').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
