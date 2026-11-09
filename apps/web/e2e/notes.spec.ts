/**
 * Milestone 6: editing a note in the app (D31) against the real backend. What lands on disk is
 * a minimal diff; a save elsewhere meanwhile is merged field by field.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { DISHWASHER, expect, expectNoA11yViolations, item, panel, test } from './support/fixtures';

const NOTE = 'House/Kitchen/Dishwasher.md';
const read = (dir: string) => readFileSync(join(dir, NOTE), 'utf8');
const editorForm = (page: Page) => panel(page).getByRole('form', { name: 'Edit note' });

async function openEditor(page: Page, url: string) {
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
  await panel(page).getByRole('button', { name: 'Edit note' }).click();
  await expect(editorForm(page)).toBeVisible();
}

test.describe('note editor', () => {
  test('viewers see no Edit button', async ({ page }) => {
    await page.goto(`/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Edit note' })).toHaveCount(0);
  });

  test('edits fields and notes; only the changed lines change on disk', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    const before = read(dataDir);
    await openEditor(page, url);
    await expectNoA11yViolations(page);

    const form = editorForm(page);
    await form.getByLabel('Brand').fill('Siemens');
    await form.getByLabel('Next check').fill('2027-01-15');
    await form.getByLabel('Check every').fill('6m');
    const body = form.getByLabel('Notes (Markdown)');
    await body.fill(
      (await body.inputValue()).replace('Add salt every 2 months.', 'Add salt monthly.'),
    );
    await form.getByRole('button', { name: 'Preview' }).click();
    await expect(form.getByText('Add salt monthly.')).toBeVisible();
    await form.getByRole('button', { name: 'Save' }).click();

    await expect(panel(page).getByText('Saved.')).toBeVisible();
    await expect(panel(page).locator('.p-head .sub')).toHaveText('Siemens · SMS4HVI33E');
    await expect(panel(page).getByText('Add salt monthly.')).toBeVisible();

    const after = read(dataDir);
    expect(after).toBe(
      before
        .replace('brand: Bosch', 'brand: Siemens')
        .replace(
          'tags: [housebook]\n',
          'tags: [housebook]\nnext_check: 2027-01-15\ncheck_every: 6m\n',
        )
        .replace('Add salt every 2 months.', 'Add salt monthly.'),
    );
  });

  test('a save elsewhere meanwhile is merged; the same field changed on both sides asks', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await openEditor(page, url);
    const form = editorForm(page);
    await form.getByLabel('Brand').fill('Siemens');

    // Someone edits another field in Obsidian: merged without asking.
    writeFileSync(join(dataDir, NOTE), read(dataDir).replace('model: SMS4HVI33E', 'model: SX1'));
    await expect(form.getByRole('note')).toContainText('changed elsewhere');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(panel(page).getByText('Saved.')).toBeVisible();
    expect(read(dataDir)).toContain('brand: Siemens');
    expect(read(dataDir)).toContain('model: SX1');

    // Now both change the serial number: the user chooses.
    await panel(page).getByRole('button', { name: 'Edit note' }).click();
    await form.getByLabel('Serial number').fill('MINE-1');
    writeFileSync(
      join(dataDir, NOTE),
      read(dataDir).replace('serial: FD 0412 00123', 'serial: THEIRS-2'),
    );
    await expect(form.getByRole('note')).toContainText('changed elsewhere');
    await form.getByRole('button', { name: 'Save' }).click();
    const alert = form.getByRole('alert');
    await expect(alert).toContainText('Theirs: THEIRS-2 · yours: MINE-1');
    expect(read(dataDir)).toContain('serial: THEIRS-2');
    await form.getByRole('button', { name: 'Save' }).click(); // keep mine
    await expect(panel(page).getByText('Saved.')).toBeVisible();
    expect(read(dataDir)).toContain('serial: MINE-1');
  });

  test('a draft survives closing the panel', async ({ page, backend }) => {
    const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await openEditor(page, url);
    await editorForm(page).getByLabel('Serial number').fill('DRAFT-9');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await item(page, DISHWASHER).click();
    await expect(editorForm(page).getByLabel('Serial number')).toHaveValue('DRAFT-9');
    await editorForm(page).getByRole('button', { name: 'Discard changes' }).click();
    await expect(panel(page).getByRole('button', { name: 'Edit note' })).toBeVisible();
  });
});

test.describe('delete item', () => {
  test('viewers see no Delete button', async ({ page }) => {
    await page.goto(`/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Delete item' })).toHaveCount(0);
  });

  test('takes it off the plan, moves note and folder to the trash; undo can’t bring a ghost back', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    await panel(page).getByRole('button', { name: 'Delete item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete “Dishwasher”?' });
    await expect(dialog).toContainText('It is taken off the plan.');
    await expect(dialog).toContainText('House/Kitchen/Dishwasher/');
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.ed-notice')).toContainText('“Dishwasher” was deleted');
    await expect(item(page, DISHWASHER)).toHaveCount(0);
    await expect(page.locator(`.plan [data-ghost-id="${DISHWASHER}"]`)).toHaveCount(0);

    expect(existsSync(join(dataDir, NOTE))).toBe(false);
    expect(existsSync(join(dataDir, 'House/Kitchen/Dishwasher'))).toBe(false);
    const trash = readdirSync(join(dataDir, '.housebook/trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(new RegExp(`-${DISHWASHER}$`));
    expect(readdirSync(join(dataDir, '.housebook/trash', trash[0]!)).sort()).toEqual([
      'Dishwasher',
      'Dishwasher.md',
    ]);
    const house = JSON.parse(readFileSync(join(dataDir, 'house.json'), 'utf8')) as {
      placements: { itemId: string }[];
    };
    expect(house.placements.map((p) => p.itemId)).not.toContain(DISHWASHER);

    // Undoing "remove from plan" would place an item without a note: refused, with the reason.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.ed-notice').last()).toContainText('its note was deleted');
    await expect(page.locator(`.plan [data-ghost-id="${DISHWASHER}"]`)).toHaveCount(0);
  });
});

test.describe('attachments', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  // A 1×1 PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  test('editors add files, see them listed, and remove one to the trash', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'live');
    const section = panel(page).getByRole('region', { name: 'Attachments' });

    await section.getByLabel('Files to attach').setInputFiles([
      { name: 'Invoice.pdf', mimeType: 'application/pdf', buffer: PDF },
      { name: 'plate.png', mimeType: 'image/png', buffer: PNG },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    ]);
    await expect(section.getByRole('status')).toHaveText('2 files added.');
    await expect(section.getByRole('alert')).toContainText(
      'notes.txt: only PDF, JPEG, PNG, WebP or HEIC files can be attached.',
    );
    await expect(section.getByRole('button', { name: 'View Invoice.pdf' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Preview plate.png' })).toBeVisible();
    expect(readFileSync(join(dataDir, 'House/Kitchen/Dishwasher/Invoice.pdf'))).toEqual(PDF);
    expect(existsSync(join(dataDir, 'House/Kitchen/Dishwasher/notes.txt'))).toBe(false);
    expect(read(dataDir)).toContain(
      'attachments: ["[[Dishwasher/manual.pdf]]", "[[Dishwasher/Invoice.pdf]]", "[[Dishwasher/plate.png]]"]',
    );
    await expectNoA11yViolations(page);

    await section.getByRole('button', { name: 'Remove Invoice.pdf' }).click();
    await section.getByRole('button', { name: 'Remove Invoice.pdf' }).click(); // confirm
    await expect(section.getByRole('status')).toHaveText('Invoice.pdf moved to the trash.');
    await expect(section.getByRole('button', { name: 'View Invoice.pdf' })).toHaveCount(0);
    expect(existsSync(join(dataDir, 'House/Kitchen/Dishwasher/Invoice.pdf'))).toBe(false);
    expect(read(dataDir)).not.toContain('Invoice.pdf');
  });

  test('viewers can’t add or remove files', async ({ page }) => {
    await page.goto(`/i/${DISHWASHER}`);
    const section = panel(page).getByRole('region', { name: 'Attachments' });
    await expect(section.getByRole('button', { name: 'View manual.pdf' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Add files' })).toHaveCount(0);
    await expect(section.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  });
});
