/**
 * Details panel and keyboard behaviour: focus in and out, Esc, Tab order in the panel and the
 * list, room panel, attachments (image preview, PDF paging, files that went missing).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  CHEST_FREEZER,
  DISHWASHER,
  FRIDGE,
  expect,
  gotoPlan,
  item,
  panel,
  planView,
  searchBox,
  test,
} from './support/fixtures';
import { makePdf } from './support/server';

async function tabTo(page: Page, target: Locator, shift = false) {
  await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
  await expect(target).toBeFocused();
}

test('Esc closes the panel and returns focus to the item, wherever it was opened from', async ({
  page,
}) => {
  await gotoPlan(page);
  // From the plan, with the keyboard only: Tab reaches the item badges.
  await item(page, DISHWASHER).focus();
  await page.keyboard.press('Enter');
  const details = panel(page);
  await expect(details.getByRole('heading', { level: 2, name: 'Dishwasher' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(item(page, DISHWASHER)).toBeFocused();

  // Space works like Enter.
  await page.keyboard.press(' ');
  await expect(details.getByRole('heading', { name: 'Dishwasher' })).toBeFocused();

  // Close button does the same as Esc.
  await details.getByRole('button', { name: 'Close details' }).click();
  await expect(details).toBeHidden();
  await expect(item(page, DISHWASHER)).toBeFocused();

  // Opened from search: focus lands on the item on the plan afterwards.
  await searchBox(page).fill('fridge');
  await searchBox(page).press('Enter');
  await expect(details.getByRole('heading', { name: 'Fridge' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(item(page, FRIDGE)).toBeFocused();
});

test('Esc inside the search box never closes the panel', async ({ page }) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeFocused();
  await searchBox(page).fill('fri');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await searchBox(page).press('Escape');
  await searchBox(page).press('Escape');
  await expect(searchBox(page)).toHaveValue('');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeHidden();
  await expect(panel(page)).toBeVisible();
  await searchBox(page).press('Escape'); // even with an empty query
  await expect(panel(page)).toBeVisible();
});

test('FE-02: the first Esc in the search box closes the dropdown and keeps the query', async ({
  page,
}) => {
  await gotoPlan(page);
  await searchBox(page).fill('fri');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await searchBox(page).press('Escape');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeHidden();
  await expect(searchBox(page)).toHaveValue('fri', { timeout: 1_000 });
});

test('Tab order in the item panel follows reading order', async ({ page }) => {
  await gotoPlan(page);
  await item(page, DISHWASHER).click();
  const d = panel(page);
  await expect(d.getByRole('heading', { name: 'Dishwasher' })).toBeFocused();
  // Attachments render once the panel is open; wait for the last one.
  await expect(d.getByRole('link', { name: 'Download receipt.png' })).toBeVisible();

  const order = [
    d.getByRole('button', { name: 'Close details' }),
    d.getByRole('link', { name: 'Manual', exact: true }),
    d.getByRole('link', { name: 'Open in Obsidian' }),
    d.getByRole('button', { name: 'View manual.pdf' }),
    d.getByRole('link', { name: 'Download manual.pdf' }),
    d.getByRole('button', { name: 'Preview receipt.png' }),
    d.getByRole('link', { name: 'Download receipt.png' }),
  ];
  for (const el of order) await tabTo(page, el);
  for (const el of order.slice(0, -1).reverse()) await tabTo(page, el, true);
  // External links open in a new tab without an opener.
  await expect(order[1]!).toHaveAttribute('target', '_blank');
  await expect(order[1]!).toHaveAttribute('rel', /noopener/);
});

test('room panel: title, area, items, and focus return to the room label', async ({ page }) => {
  await gotoPlan(page);
  const label = page.locator('.plan [data-room-id="rm_kit"]');
  await label.focus();
  await page.keyboard.press('Enter');
  const d = panel(page);
  await expect(d.getByRole('heading', { level: 2, name: 'Kitchen' })).toBeFocused();
  await expect(d.getByText('Room · 16 m² · Apartment')).toBeVisible();
  await expect(d.getByRole('listitem')).toHaveText([/Dishwasher/, /Fridge/, /Microwave/, /Oven/]);
  await expect(page.locator('.plan .room.sel')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(d).toBeHidden();
  await expect(label).toBeFocused();

  // An empty room says so.
  await page.locator('.plan [data-room-id="rm_off"]').click();
  await expect(d.getByRole('heading', { name: 'Office' })).toBeVisible();
  await expect(d.getByText('Nothing in this room yet.')).toBeVisible();

  // An item row opens the item.
  await page.locator('.plan [data-room-id="rm_kit"]').click();
  await d.getByRole('button', { name: /Fridge/ }).click();
  await expect(page).toHaveURL(`/i/${FRIDGE}`);
  await expect(d.getByRole('heading', { name: 'Fridge' })).toBeFocused();
});

test('list view: Tab order, arrow keys, Enter opens and Esc returns', async ({ page }) => {
  await gotoPlan(page);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const list = page.getByRole('region', { name: 'Items by floor and room' });
  const nav = list.locator('[data-nav]');
  await expect(nav.first()).toBeVisible();

  // Floor headings in level order, rooms by name inside.
  await expect(list.getByRole('heading', { level: 2 })).toHaveText([/^Apartment/, /^Basement/]);

  // Tab from the last header control enters the list at its first entry, then walks it in order.
  await page.locator('header.top button.theme').focus();
  await tabTo(page, nav.nth(0));
  for (let i = 1; i < 6; i++) await tabTo(page, nav.nth(i));
  // Arrows, Home/End.
  await page.keyboard.press('ArrowUp');
  await expect(nav.nth(4)).toBeFocused();
  await page.keyboard.press('End');
  await expect(nav.last()).toBeFocused();
  await page.keyboard.press('ArrowDown'); // stays on the last one
  await expect(nav.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(nav.first()).toBeFocused();

  // Every list entry is a native button (operable with Enter/Space).
  const tags = await nav.evaluateAll((els) => [...new Set(els.map((e) => e.tagName))]);
  expect(tags).toEqual(['BUTTON']);

  // Enter on a room opens the room panel; Esc goes back to the row.
  const kitchen = list.locator('[data-room-id="rm_kit"]');
  await kitchen.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { name: 'Kitchen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(kitchen).toBeFocused();

  // The basement item is listed under its floor.
  const freezer = list.locator(`[data-item-id="${CHEST_FREEZER}"]`);
  await freezer.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { name: 'Chest freezer' })).toBeFocused();
  await expect(freezer).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(freezer).toBeFocused();
});

test('image attachment preview loads the image and closes back to its button', async ({ page }) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  const open = panel(page).getByRole('button', { name: 'Preview receipt.png' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'receipt.png' });
  const img = dialog.getByRole('img', { name: 'receipt.png' });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // Backdrop click closes it too.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(panel(page)).toBeVisible(); // Esc in the dialog doesn't close the panel too
  await open.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(panel(page)).toBeVisible();
});

test.describe('FE-03: closing an attachment dialog returns focus to the button that opened it', () => {
  test('image, closed with Esc', async ({ page }) => {
    await gotoPlan(page, `/i/${DISHWASHER}`);
    const open = panel(page).getByRole('button', { name: 'Preview receipt.png' });
    await open.click();
    await expect(page.getByRole('dialog', { name: 'receipt.png' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(open).toBeFocused({ timeout: 1_000 });
  });
  test('PDF, closed with the Close button', async ({ page }) => {
    await gotoPlan(page, `/i/${DISHWASHER}`);
    const open = panel(page).getByRole('button', { name: 'View manual.pdf' });
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'manual.pdf' });
    await expect(dialog.getByText('Page 1 of 1')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused({ timeout: 1_000 });
  });
});

test.describe('PDF viewer', () => {
  test('pages, zooms and closes', async ({ page, backend }) => {
    const { url } = await backend({
      files: { 'House/Kitchen/Dishwasher/manual.pdf': makePdf(['One', 'Two', 'Three']) },
    });
    await page.goto(`${url}/i/${DISHWASHER}`);
    const view = panel(page).getByRole('button', { name: 'View manual.pdf' });
    await view.click();
    const dialog = page.getByRole('dialog', { name: 'manual.pdf' });
    await expect(dialog.getByText('Page 1 of 3')).toBeVisible();
    const prev = dialog.getByRole('button', { name: 'Previous' });
    const next = dialog.getByRole('button', { name: 'Next' });
    await expect(prev).toBeDisabled();

    const canvas = dialog.getByRole('img', { name: 'manual.pdf, page 1' });
    const inked = () =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
        return dark;
      });
    await expect.poll(inked).toBeGreaterThan(200);
    const page1 = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());

    await next.click();
    await expect(dialog.getByText('Page 2 of 3')).toBeVisible();
    const canvas2 = dialog.getByRole('img', { name: 'manual.pdf, page 2' });
    await expect
      .poll(() => canvas2.evaluate((c: HTMLCanvasElement) => c.toDataURL()))
      .not.toBe(page1);
    await next.click();
    await expect(dialog.getByText('Page 3 of 3')).toBeVisible();
    await expect(next).toBeDisabled();
    await prev.click();
    await expect(dialog.getByText('Page 2 of 3')).toBeVisible();

    const width = () =>
      dialog.getByTestId('pdf-canvas').evaluate((c: HTMLCanvasElement) => c.clientWidth);
    const w0 = await width();
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(width).toBeGreaterThan(w0 * 1.2);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page)).toBeVisible();
  });

  test('an attachment deleted after loading shows an error with a download link', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('button', { name: 'View manual.pdf' })).toBeVisible();
    rmSync(join(dataDir, 'House/Kitchen/Dishwasher/manual.pdf'));
    await panel(page).getByRole('button', { name: 'View manual.pdf' }).click();
    const dialog = page.getByRole('dialog', { name: 'manual.pdf' });
    await expect(dialog.getByRole('alert')).toContainText('Couldn’t show this PDF');
    await expect(dialog.getByRole('link', { name: 'Download it' })).toHaveAttribute(
      'href',
      /\/api\/items\/it_7f3k2a\/attachments\/manual\.pdf$/,
    );
  });

  test('a file that is not a PDF shows an error, not a blank viewer', async ({ page, backend }) => {
    const { url } = await backend({
      files: { 'House/Kitchen/Dishwasher/manual.pdf': '%PDF-1.4\nthis is not really a pdf\n' },
    });
    await page.goto(`${url}/i/${DISHWASHER}`);
    await panel(page).getByRole('button', { name: 'View manual.pdf' }).click();
    const dialog = page.getByRole('dialog', { name: 'manual.pdf' });
    await expect(dialog.getByRole('alert')).toContainText('Couldn’t show this PDF');
  });
});

test('FE-01: an image attachment that went missing says so in the preview', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend();
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('button', { name: 'Preview receipt.png' })).toBeVisible();
  rmSync(join(dataDir, 'House/Kitchen/Dishwasher/receipt.png'));
  await page.route('**/attachments/receipt.png', (r) => r.fulfill({ status: 404 }));
  await panel(page).getByRole('button', { name: 'Preview receipt.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'receipt.png' });
  await expect(dialog.getByText(/couldn.t (load|show)|not available|missing/i)).toBeVisible({
    timeout: 3_000,
  });
});

test('a listed attachment that does not exist is not offered for download', async ({
  page,
  backend,
}) => {
  const note = `---
housebook_id: it_att001
type: other
name: Ghost attachment
attachments: ["[[Ghost attachment/gone.pdf]]"]
tags: [housebook]
---
Body.
`;
  const { url } = await backend({
    files: { 'House/Kitchen/Ghost attachment.md': note },
  });
  await page.goto(`${url}/i/it_att001`);
  await expect(panel(page).getByRole('heading', { name: 'Ghost attachment' })).toBeVisible();
  await expect(panel(page).getByText('gone.pdf')).toHaveCount(0);
  // It shows up as a data problem instead.
  await expect(page.getByRole('button', { name: /data problem/ })).toBeVisible();
});

test('"Open in Obsidian" only when a vault is configured', async ({ page, backend }) => {
  const { url } = await backend(); // no HOUSEBOOK_OBSIDIAN_VAULT
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('link', { name: 'Manual', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('link', { name: 'Open in Obsidian' })).toHaveCount(0);
});

/** Edit a note on disk and refetch (window focus) until the panel shows the change. */
async function editAndRefetch(page: Page, dataDir: string, rel: string, from: string, to: string) {
  const file = join(dataDir, rel);
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  await expect
    .poll(
      async () => {
        const res = page.waitForResponse('**/api/snapshot');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return (await res).status();
      },
      { timeout: 10_000, message: 'snapshot never changed after the edit' },
    )
    .toBe(200);
}

test('panel content follows a note edited on disk', async ({ page, backend }) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
  await editAndRefetch(page, dataDir, 'House/Kitchen/Dishwasher.md', '**E15**', '**E24**');
  await expect(panel(page).getByText('E24', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('E15', { exact: true })).toHaveCount(0);
});

test('FE-04: a background refresh does not move keyboard focus into the panel', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
  await searchBox(page).focus();
  await editAndRefetch(page, dataDir, 'House/Kitchen/Dishwasher.md', '**E15**', '**E24**');
  await expect(panel(page).getByText('E24', { exact: true })).toBeVisible();
  await expect(searchBox(page)).toBeFocused({ timeout: 1_000 });
});

test('FE-05: a background refresh keeps the user’s zoom and pan', async ({ page, backend }) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await gotoPlan(page, `${url}/`);
  await expect.poll(async () => (await planView(page)).k).not.toBe(1);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await planView(page);
  await editAndRefetch(page, dataDir, 'House/Kitchen/Fridge.md', 'Fridge', 'Fridge (edited)');
  await expect(page.locator(`.plan [data-item-id="${FRIDGE}"]`)).toHaveAttribute(
    'aria-label',
    /Fridge \(edited\)/,
  );
  expect(await planView(page)).toEqual(zoomed);
});
