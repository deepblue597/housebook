/**
 * Backup download (milestone 13, D49): an editor saves the whole data folder as a zip from the
 * ⋯ menu; viewers don't get the entry and the server refuses them.
 */
import { readFileSync } from 'node:fs';
import { expect, gotoPlan, openMore, test } from './support/fixtures';

test('an editor downloads the data folder as a zip', async ({ page, backend }) => {
  const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  await gotoPlan(page, url);
  const menu = await openMore(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('link', { name: 'Download a backup (.zip)' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^housebook-\d{8}-\d{6}Z\.zip$/);
  const zip = readFileSync(await download.path());
  expect(zip.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04'));
  // Names are stored in plain text in the zip's directory.
  const text = zip.toString('latin1');
  expect(text).toContain('house.json');
  expect(text).toContain('House/Kitchen/Dishwasher.md');
  expect(text).not.toContain('.housebook/lock');
});

test('viewers get no backup entry, and the server refuses them', async ({ page, backend }) => {
  const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'viewer' });
  await gotoPlan(page, url);
  await expect((await openMore(page)).getByRole('link', { name: /Download a backup/ })).toHaveCount(
    0,
  );
  expect((await page.request.get(`${url}/api/export`)).status()).toBe(403);
});
