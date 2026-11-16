/**
 * Receipts in Paperless-ngx (milestone 11, D52) against a fake Paperless: an editor links one by
 * searching, views it, unlinks it; a deleted one is reported; viewers only look.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FakePaperless, PAPERLESS_TOKEN, startFakePaperless } from './support/fakePaperless';
import { DISHWASHER, expect, panel, test } from './support/fixtures';
import { EXAMPLE } from './support/server';

const PUBLIC = 'https://paperless.example';

let paperless: FakePaperless;
test.beforeEach(async () => {
  paperless = await startFakePaperless([
    { id: 12, title: 'Dishwasher invoice', created: '2024-05-10' },
    { id: 13, title: 'Fridge receipt', created: '2023-02-01' },
  ]);
});
test.afterEach(() => paperless.stop());

const env = (role: string) => ({
  HOUSEBOOK_ANON_ROLE: role,
  HOUSEBOOK_PAPERLESS_URL: paperless.url,
  HOUSEBOOK_PAPERLESS_PUBLIC_URL: PUBLIC,
  HOUSEBOOK_PAPERLESS_TOKEN: PAPERLESS_TOKEN,
});

const linked = (link: string) => ({
  files: {
    'House/Kitchen/Dishwasher.md': readFileSync(
      join(EXAMPLE, 'House/Kitchen/Dishwasher.md'),
      'utf8',
    ).replace('tags: [housebook]', `receipts: ["${link}"]\ntags: [housebook]`),
  },
});

test('an editor links a receipt from Paperless, views it and unlinks it', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, env('editor'));
  await page.goto(`${url}/i/${DISHWASHER}`);
  const d = panel(page);
  await d.getByRole('button', { name: 'Link receipt' }).click();

  const search = page.getByRole('dialog', { name: 'Link a receipt from Paperless' });
  await search.getByRole('searchbox', { name: /Search Paperless/ }).fill('invoice');
  await expect(search.getByRole('listitem')).toHaveCount(1);
  await search.getByRole('button', { name: 'Link Dishwasher invoice' }).click();
  await expect(search).toBeHidden();

  await expect(d.getByRole('status').filter({ hasText: 'Receipt linked.' })).toBeVisible();
  const note = () => readFileSync(join(dataDir, 'House/Kitchen/Dishwasher.md'), 'utf8');
  expect(note()).toMatch(/^receipts:/m);
  expect(note()).toContain(`${PUBLIC}/documents/12/details`);
  await expect(
    d.getByRole('link', { name: 'Open in Paperless Dishwasher invoice' }),
  ).toHaveAttribute('href', `${PUBLIC}/documents/12/details`);

  // The preview comes through Housebook (the browser never talks to Paperless).
  await d.getByRole('button', { name: 'View Dishwasher invoice' }).click();
  const viewer = page.getByRole('dialog', { name: 'Dishwasher invoice' });
  await expect(viewer.getByText('Page 1 of 1')).toBeVisible();
  await viewer.getByRole('button', { name: 'Close' }).click();

  await d.getByRole('button', { name: 'Unlink Dishwasher invoice' }).click();
  await d.getByRole('button', { name: 'Unlink Dishwasher invoice' }).click();
  await expect(d.getByRole('status').filter({ hasText: 'Link removed.' })).toBeVisible();
  expect(note()).not.toContain('receipts:');
});

test('a receipt deleted in Paperless is shown as missing and reported', async ({
  page,
  backend,
}) => {
  paperless.docs.delete(12);
  const { url } = await backend(linked(`${PUBLIC}/documents/12/details`), env('viewer'));
  await page.goto(`${url}/i/${DISHWASHER}`);
  const d = panel(page);
  await expect(d.getByText('Not in Paperless any more, or Housebook can’t see it.')).toBeVisible();
  await expect(d.getByRole('button', { name: 'Link receipt' })).toHaveCount(0); // viewer
  await expect
    .poll(async () => {
      const r = await page.request.get(`${url}/api/problems`);
      return ((await r.json()) as { problems: { kind: string }[] }).problems.map((p) => p.kind);
    })
    .toContain('paperless_missing');
});
