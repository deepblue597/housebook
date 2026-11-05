/**
 * Behaviour that depends on the data: Markdown safety in crafted notes, snapshot ETag / 304 and
 * refetch, failed loads, houseReadOnly and problems indicators, stale and unplaced notes, and
 * the empty house. Each crafted case runs its own backend on a temp data root.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Request } from '@playwright/test';
import {
  DISHWASHER,
  FRIDGE,
  exampleHouse,
  expect,
  gotoPlan,
  panel,
  planItems,
  test,
} from './support/fixtures';
import { PNG_1PX } from './support/server';

const OVEN = 'it_9b3m7x';

// ---- Markdown safety -----------------------------------------------------------------

const NASTY = `---
housebook_id: it_nasty1
type: other
name: Nasty note
manual: "javascript:window.__pwned='manual'"
support: " JaVaScRiPt:window.__pwned='support'"
tags: [housebook]
---
## Links
- [js](javascript:window.__pwned='js')
- [js-ws](java\tscript:window.__pwned='ws')
- [data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)
- [vb](vbscript:msgbox)
- [ref link][r1]
- <javascript:window.__pwned='autolink'>
- [ok](https://example.com/ok)
- [mail](mailto:someone@example.com)
- <a href="javascript:window.__pwned='anchor'">raw anchor</a>

[r1]: javascript:window.__pwned='ref'

<script>window.__pwned = 'script'</script>
<img src="x" onerror="window.__pwned='img'">
<iframe src="https://example.com/frame"></iframe>
<svg onload="window.__pwned='svg'"></svg>
<style>body { display: none }</style>

![remote image](https://example.com/track.png)

## Wikilinks
- Item: [[Fridge]]
- Alias: [[Oven|the oven]]
- Heading: [[Dishwasher#Quick help]]
- Missing: [[Nowhere at all]]
- Code: \`[[Not a link]]\`
- Embed: ![[receipt.png]]
`;

test('note Markdown: no script, no unsafe links, no remote images; wikilinks work', async ({
  page,
  backend,
}) => {
  const { url } = await backend({
    files: {
      'House/Kitchen/Nasty note.md': NASTY,
      'House/Kitchen/Nasty note/receipt.png': PNG_1PX,
    },
  });
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const external: string[] = [];
  await page.route('https://example.com/**', (r) => {
    external.push(r.request().url());
    return r.abort();
  });

  await page.goto(`${url}/i/it_nasty1`);
  const d = panel(page);
  const md = d.locator('.md');
  await expect(d.getByRole('heading', { level: 2, name: 'Nasty note' })).toBeVisible();
  // Wait for the lazy Markdown renderer (the fallback is plain text, without links).
  await expect(md.getByRole('link', { name: 'ok' })).toHaveAttribute(
    'href',
    'https://example.com/ok',
  );
  await expect(md.getByRole('link', { name: 'ok' })).toHaveAttribute('rel', /noopener/);
  await expect(md.getByRole('link', { name: 'mail' })).toHaveAttribute(
    'href',
    'mailto:someone@example.com',
  );

  // Every href in the panel uses an allowed scheme or is in-app.
  const hrefs = await d.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  for (const h of hrefs)
    expect(h).toMatch(/^(https?:|mailto:|tel:|obsidian:|\/i\/|\/api\/items\/)/);
  // Unsafe links render as text; frontmatter manual/support with javascript: are dropped.
  for (const name of ['js', 'data', 'vb', 'ref link']) {
    await expect(md.getByText(name, { exact: true })).toBeVisible();
    await expect(md.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  // A tab inside the scheme makes it no link destination at all: literal text.
  await expect(md.getByText(/\[js-ws\]/)).toBeVisible();
  await expect(md.getByRole('link', { name: /js-ws|autolink/ })).toHaveCount(0);
  await expect(d.getByRole('link', { name: 'Manual', exact: true })).toHaveCount(0);
  await expect(d.getByRole('link', { name: 'Support', exact: true })).toHaveCount(0);

  // Raw HTML is never rendered.
  await expect(
    d.locator('script, iframe, style, svg[onload], img[onerror], [onerror], [onload]'),
  ).toHaveCount(0);
  // The tags are dropped; the anchor's inner text stays as plain text.
  await expect(md.getByRole('link', { name: 'raw anchor' })).toHaveCount(0);
  await expect(page.locator('body')).toBeVisible();

  // Remote images become links and are not fetched.
  await expect(md.getByRole('link', { name: 'remote image' })).toHaveAttribute(
    'href',
    'https://example.com/track.png',
  );
  await expect(md.locator('img[src^="https://"]')).toHaveCount(0);

  // Wikilinks: resolved ones are in-app links, the rest stay text.
  await expect(md.getByRole('link', { name: 'Fridge' })).toHaveAttribute('href', `/i/${FRIDGE}`);
  await expect(md.getByRole('link', { name: 'the oven' })).toHaveAttribute('href', `/i/${OVEN}`);
  await expect(md.getByRole('link', { name: /Dishwasher/ })).toHaveAttribute(
    'href',
    `/i/${DISHWASHER}`,
  );
  await expect(md.getByText('Nowhere at all')).toBeVisible();
  await expect(md.getByRole('link', { name: 'Nowhere at all' })).toHaveCount(0);
  await expect(md.locator('code')).toHaveText('[[Not a link]]');
  const embed = md.locator('img[src$="/attachments/receipt.png"]');
  await expect(embed).toHaveAttribute('src', '/api/items/it_nasty1/attachments/receipt.png');
  await expect.poll(() => embed.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);

  // Clicking a wikilink navigates in-app (no reload) and keeps history.
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  await md.getByRole('link', { name: 'Fridge' }).click();
  await expect(page).toHaveURL(`${url}/i/${FRIDGE}`);
  await expect(d.getByRole('heading', { level: 2, name: 'Fridge' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await page.goBack();
  await expect(d.getByRole('heading', { level: 2, name: 'Nasty note' })).toBeVisible();

  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned),
  ).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(external).toEqual([]);
});

// ---- snapshot loading ----------------------------------------------------------------

function snapshotLog(page: Page) {
  const log: { req: Request; status?: number; etag?: string | null }[] = [];
  // 'response', not 'requestfinished': Chromium reports a 304 whose (empty) body is never read
  // as aborted.
  page.on('response', async (res) => {
    if (!res.url().endsWith('/api/snapshot')) return;
    log.push({ req: res.request(), status: res.status(), etag: await res.headerValue('etag') });
  });
  return log;
}

test('snapshot: ETag on first load, If-None-Match and 304 on focus and visibility @smoke', async ({
  page,
}) => {
  const log = snapshotLog(page);
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await expect.poll(() => log.length).toBe(1);
  const first = log[0]!;
  expect(first.status).toBe(200);
  expect(first.etag).toBeTruthy();
  expect(await first.req.headerValue('if-none-match')).toBeNull();

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => log.length).toBe(2);
  expect(await log[1]!.req.headerValue('if-none-match')).toBe(first.etag);
  expect(log[1]!.status).toBe(304);

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => log.length).toBe(3);
  expect(log[2]!.status).toBe(304);

  // A 304 changes nothing on screen and shows no error.
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await expect(planItems(page)).toHaveCount(13);
  await expect(page.getByText(/Couldn’t refresh/)).toHaveCount(0);
});

test('snapshot: a changed file is picked up on focus with a new ETag', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  const log = snapshotLog(page);
  await gotoPlan(page, `${url}/`);
  await expect.poll(() => log.length).toBe(1);
  const file = join(dataDir, 'House/Kitchen/Fridge.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: Fridge', 'name: Big fridge'));
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return page.locator(`.plan [data-item-id="${FRIDGE}"]`).getAttribute('aria-label');
      },
      { timeout: 10_000 },
    )
    .toMatch(/^Big fridge/);
  const changed = log.find((l) => l.status === 200 && l !== log[0]);
  expect(changed?.etag).toBeTruthy();
  expect(changed?.etag).not.toBe(log[0]!.etag);
  expect(await changed!.req.headerValue('if-none-match')).toBe(log[0]!.etag);
});

test('snapshot: a failed refresh keeps the data and offers Retry', async ({ page }) => {
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  await page.route('**/api/snapshot', (r) => r.fulfill({ status: 503, body: 'down' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const banner = page.getByRole('status').filter({ hasText: 'Couldn’t refresh' });
  await expect(banner).toContainText('showing data from');
  await expect(planItems(page)).toHaveCount(13);
  await page.unroute('**/api/snapshot');
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toHaveCount(0);
});

test('snapshot: a failed first load shows an error with Try again', async ({ page }) => {
  let fail = true;
  await page.route('**/api/snapshot', (r) =>
    fail ? r.fulfill({ status: 500, body: 'boom' }) : r.continue(),
  );
  await page.goto('/');
  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { name: 'Couldn’t load the house' })).toBeVisible();
  await expect(alert).toContainText('500');
  fail = false;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(planItems(page)).toHaveCount(13);
});

// ---- read-only, problems, stale, unplaced, empty -------------------------------------

test('a newer house.json schema is shown read-only with a banner and a problem count', async ({
  page,
  backend,
}) => {
  const house = { ...exampleHouse(), schemaVersion: 2, futureKey: { x: 1 } };
  const { url } = await backend({ house });
  await gotoPlan(page, `${url}/`);
  await expect(page.getByRole('note').filter({ hasText: 'read-only' })).toHaveText(
    'This house layout was written by a newer Housebook version (schema 2). It is shown read-only.',
  );
  await expect(planItems(page)).toHaveCount(13); // still fully viewable
  const problems = (await (await page.request.get(`${url}/api/problems`)).json()) as {
    count: number;
  };
  expect(problems.count).toBeGreaterThanOrEqual(1);
  const link = page.getByRole('link', { name: /data problems?, opens the integrity report/ });
  await expect(link).toHaveAttribute('href', '/api/problems');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toContainText(String(problems.count));
});

test('a broken note is counted as a problem; the rest of the house loads', async ({
  page,
  backend,
}) => {
  const { url } = await backend({
    files: {
      'House/Kitchen/Broken.md':
        '---\nhousebook_id: it_broken\nname: [unclosed\ntags: [housebook]\n---\nBody\n',
    },
  });
  await gotoPlan(page, `${url}/`);
  const problems = (await (await page.request.get(`${url}/api/problems`)).json()) as {
    count: number;
  };
  expect(problems.count).toBeGreaterThanOrEqual(1);
  await expect(page.locator('header .problems')).toContainText(String(problems.count));
  await expect(planItems(page)).toHaveCount(13);
  await expect(page.getByRole('note').filter({ hasText: 'read-only' })).toHaveCount(0);
});

test('no problems: no indicator', async ({ page }) => {
  const problems = (await (await page.request.get('/api/problems')).json()) as { count: number };
  test.skip(problems.count > 0, 'examples/house has problems');
  await gotoPlan(page);
  await expect(page.locator('header .problems')).toHaveCount(0);
});

test('a note that breaks after loading shows its last good version with a notice', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
  const file = join(dataDir, 'House/Kitchen/Dishwasher.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: Dishwasher', 'name: [unclosed'));
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return panel(page).getByRole('note').count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect(panel(page).getByRole('note')).toContainText('can’t be read');
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
});

test('an unplaced note is listed as Unplaced and opens from its deep link', async ({
  page,
  backend,
}) => {
  const { url } = await backend({
    files: {
      'House/Spare kettle.md':
        '---\nhousebook_id: it_kettle\ntype: other\nname: Spare kettle\ntags: [housebook]\n---\n',
    },
  });
  await gotoPlan(page, `${url}/`);
  await expect(page.locator('.plan [data-item-id="it_kettle"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const unplaced = page.getByRole('region', { name: 'Unplaced' });
  await expect(unplaced.getByRole('button', { name: /Spare kettle/ })).toBeVisible();
  await unplaced.getByRole('button', { name: /Spare kettle/ }).click();
  await expect(panel(page).getByText('No room · Unplaced')).toBeVisible();
});

test('empty data root: no plan yet, list says no items', async ({ page, backend }) => {
  const { url } = await backend({ fromExample: false });
  await page.goto(`${url}/`);
  await expect(page.getByRole('heading', { name: 'No floor plan yet' })).toBeVisible();
  // A missing house.json is not "read-only" (nothing to protect).
  await expect(page.getByRole('note').filter({ hasText: 'read-only' })).toHaveCount(0);
  await expect(page.locator('header .problems')).toContainText('1');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByText('No items yet.')).toBeVisible();
  await page.goto(`${url}/i/it_nope00`);
  await expect(panel(page).getByRole('heading', { name: 'Item not found' })).toBeVisible();
});

test('a floor without rooms says so on the plan', async ({ page, backend }) => {
  const house = exampleHouse();
  const empty = {
    ...house,
    floors: [...house.floors, { id: 'fl_1', name: 'Attic', level: 1, cells: {} }],
  };
  const { url } = await backend({ house: empty });
  await gotoPlan(page, `${url}/`);
  // Highest level first.
  await expect(page.getByRole('group', { name: 'Floors' }).getByRole('button')).toHaveText([
    'Attic',
    'Apartment',
    'Basement',
  ]);
  await page.getByRole('button', { name: 'Attic' }).click();
  await expect(page.locator('.plan text.empty')).toHaveText('This floor has no rooms yet.');
  await expect(planItems(page)).toHaveCount(0);
});

test('FE-06: an invalid house.json is not blamed on a newer Housebook version', async ({
  page,
  backend,
}) => {
  const { url } = await backend({ house: { schemaVersion: 1, grid: 'nope' } });
  await page.goto(`${url}/`);
  await expect(page.getByRole('heading', { name: 'No floor plan yet' })).toBeVisible();
  await expect(page.getByText(/newer Housebook version/)).toHaveCount(0, { timeout: 1_000 });
});

test('FE-07: the problems link has a clean accessible name', async ({ page, backend }) => {
  const { url } = await backend({ fromExample: false }); // one problem: house.json missing
  await page.goto(`${url}/`);
  await expect(page.locator('header .problems')).toBeVisible();
  await expect(page.locator('header .problems')).toHaveAccessibleName(
    '1 data problem, opens the integrity report',
    { timeout: 1_000 },
  );
});
