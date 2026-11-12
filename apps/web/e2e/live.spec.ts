/**
 * Milestone 4 on the client: live updates over SSE (data contract §9), the polling fallback and
 * expired logins (DESIGN 15.7), visible inconsistent states (15.2), the problems panel and the
 * first write (maintenance log). Every test that changes data has its own backend.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  FRIDGE,
  exampleHouse,
  expect,
  expectNoA11yViolations,
  gotoPlan,
  item,
  panel,
  test,
} from './support/fixtures';

const sync = (page: Page) => page.locator('[data-sync]');
const edit = (dir: string, rel: string, from: string, to: string) => {
  const file = join(dir, rel);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
};

/** Requests to an /api path (method + path), from now on. */
function apiLog(page: Page) {
  const log: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) log.push(`${r.method()} ${u.pathname}`);
  });
  return log;
}

test.describe('live updates over SSE', () => {
  test('a note edited on disk updates the open panel and the plan without reloading', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await expect(sync(page)).toHaveAccessibleName(/live/i);
    const log = apiLog(page);

    edit(dataDir, 'House/Kitchen/Dishwasher.md', '**E15**', '**E24**');
    await expect(panel(page).getByText('E24', { exact: true })).toBeVisible();
    await expect(panel(page).getByText('E15', { exact: true })).toHaveCount(0);
    // One item fetched, not the whole snapshot.
    expect(log).toContain(`GET /api/items/${DISHWASHER}`);
    expect(log).not.toContain('GET /api/snapshot');

    edit(dataDir, 'House/Kitchen/Fridge.md', 'name: Fridge', 'name: Big fridge');
    await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Big fridge/);
  });

  test('house.json changed on disk: only the layout is fetched and the item moves', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const before = await item(page, FRIDGE).getAttribute('transform');
    const log = apiLog(page);
    const house = exampleHouse();
    const p = house.placements.find((x) => x.itemId === FRIDGE)!;
    // Swap with another placement on the same floor, so the target tile is valid.
    const other = house.placements.find((x) => x.itemId !== FRIDGE && x.floorId === p.floorId)!;
    [p.x, p.y, other.x, other.y] = [other.x, other.y, p.x, p.y];
    writeFileSync(join(dataDir, 'house.json'), `${JSON.stringify(house, null, 2)}\n`);
    await expect.poll(() => item(page, FRIDGE).getAttribute('transform')).not.toBe(before);
    expect(log).toContain('GET /api/house');
    expect(log).not.toContain('GET /api/snapshot');
  });

  test('a note that becomes unreadable is flagged on the plan and keeps its last good content', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: Dishwasher', 'name: [unclosed');
    await expect(item(page, DISHWASHER)).toHaveAttribute('aria-label', /note can’t be read/);
    await expect(item(page, DISHWASHER)).toHaveClass(/stale/);
    await expect(panel(page).getByRole('note')).toContainText('can’t be read');
    await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
    // The problems badge follows problems.changed.
    await expect(page.getByRole('button', { name: /data problems?\. Show/ })).toBeVisible();
  });

  test('a deleted note leaves a "note missing" ghost on the plan, in 2D and 3D', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    rmSync(join(dataDir, 'House/Kitchen/Fridge.md'));
    // Announced after the server's ~3 s grace period for renames.
    const ghost = page.locator(`.plan [data-ghost-id="${FRIDGE}"]`);
    await expect(ghost).toBeVisible({ timeout: 10_000 });
    await expect(item(page, FRIDGE)).toHaveCount(0);
    await expect(ghost).toHaveAccessibleName(/^Note missing/);
    await ghost.click();
    await expect(panel(page).getByRole('heading', { name: 'Note missing' })).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole('button', { name: '3D' }).click();
    await expect(page.locator('.scene3d')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator(`[data-anchor="ghost:${FRIDGE}"]`)).toHaveText('note missing');
  });

  test('a new note appears without a reload', async ({ page, backend }) => {
    const { url, dataDir } = await backend();
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    writeFileSync(
      join(dataDir, 'House/Kettle.md'),
      '---\nhousebook_id: it_kett01\ntype: other\nname: Spare kettle\ntags: [housebook]\n---\n',
    );
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.getByRole('button', { name: /Spare kettle/ })).toBeVisible();
  });
});

test.describe('fallback and auth', () => {
  const fast = { reconnectMs: 100, pollMs: 500, sseRetryMs: 2_000, resyncTimeoutMs: 2_000 };

  test('repeated SSE errors switch to polling; edits still arrive; SSE comes back', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await page.addInitScript(
      (t) => ((window as { __housebookSyncTimings?: unknown }).__housebookSyncTimings = t),
      fast,
    );
    let blocked = true;
    await page.route('**/api/events', (r) => (blocked ? r.abort() : r.fallback()));
    const snapshots: (string | null)[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/snapshot')) snapshots.push(r.headers()['if-none-match'] ?? null);
    });
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'polling');
    await expect(sync(page)).toHaveAccessibleName(/every 30 seconds/);
    // Polls revalidate with If-None-Match.
    await expect.poll(() => snapshots.length).toBeGreaterThan(2);
    expect(snapshots.slice(1).every((h) => !!h)).toBe(true);

    edit(dataDir, 'House/Kitchen/Fridge.md', 'name: Fridge', 'name: Polled fridge');
    await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Polled fridge/, {
      timeout: 10_000,
    });

    blocked = false;
    await expect(sync(page)).toHaveAttribute('data-sync', 'live', { timeout: 10_000 });
  });

  const setTimings = (page: Page) =>
    page.addInitScript((t) => {
      (window as { __housebookSyncTimings?: unknown }).__housebookSyncTimings = t;
    }, fast);

  test('server unreachable: offline indicator, last data stays', async ({ page }) => {
    await setTimings(page);
    await page.route('**/api/events', (r) => r.abort());
    await gotoPlan(page);
    await expect(page.locator('.plan [data-item-id]').first()).toBeVisible();
    await page.route('**/api/**', (r) => r.abort());
    await expect(sync(page)).toHaveAttribute('data-sync', 'offline', { timeout: 10_000 });
    await expect(sync(page)).toHaveAccessibleName(/can’t reach the server/);
    await expect(page.locator('.plan [data-item-id]').first()).toBeVisible();
  });

  test('an expired login (401 from /api/me after an SSE error) reloads the page, once', async ({
    page,
  }) => {
    await setTimings(page);
    // EventSource can't see the proxy's 401; /api/me can.
    await page.route('**/api/events', (r) => r.abort());
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, body: '{}' }));
    let loads = 0;
    page.on('load', () => (loads += 1));
    await page.goto('/');
    await expect.poll(() => loads, { timeout: 10_000 }).toBe(2);
    // At most one reload a minute: no loop while the proxy keeps answering 401.
    await page.waitForTimeout(2_000);
    expect(loads).toBe(2);
  });
});

test.describe('problems panel', () => {
  const files = {
    'House/Kitchen/Kettle.md': '---\ntype: other\nname: Kettle\ntags: [housebook]\n---\nBody.\n',
    'House/Kitchen/Broken.md':
      '---\nhousebook_id: it_broken\nname: [unclosed\ntags: [housebook]\n---\nBody\n',
  };

  test('lists problems by kind; viewers see no fix buttons', async ({ page, backend }) => {
    const { url } = await backend({ files });
    await gotoPlan(page, `${url}/`);
    await page.getByRole('button', { name: /data problems?\. Show/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Data problems' });
    await expect(dialog.getByRole('heading', { name: /Notes that can’t be read/ })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /Notes not yet adopted/ })).toBeVisible();
    await expect(dialog).toContainText('House/Kitchen/Kettle.md');
    await expect(dialog.getByRole('button', { name: 'Adopt' })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /data problems?\. Show/ })).toBeFocused();
  });

  test('an editor adopts a note explicitly; the list and the count follow', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({ files }, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await gotoPlan(page, `${url}/`);
    const badge = page.getByRole('button', { name: /data problems?\. Show/ });
    const before = Number((await badge.textContent())!.replace(/\D/g, ''));
    await badge.click();
    const dialog = page.getByRole('dialog', { name: 'Data problems' });
    await dialog.getByRole('button', { name: 'Adopt' }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      /Adopted House\/Kitchen\/Kettle\.md as it_/,
    );
    await expect(dialog.getByRole('heading', { name: /Notes not yet adopted/ })).toHaveCount(0);
    expect(readFileSync(join(dataDir, 'House/Kitchen/Kettle.md'), 'utf8')).toMatch(
      /^---\nhousebook_id: it_[a-z0-9]{6}\n/,
    );
    await expect(badge).toContainText(String(before - 1));
  });
});

test.describe('maintenance log entry', () => {
  test('viewers see no write UI', async ({ page }) => {
    await page.goto(`/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
    await expect(panel(page).getByRole('form', { name: 'Add to maintenance log' })).toHaveCount(0);
  });

  test('an editor adds an entry: written to the note, shown at once, no refetch of our own write', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const form = panel(page).getByRole('form', { name: 'Add to maintenance log' });
    await form.getByLabel('Maintenance log entry').fill('Cleaned the filter (e2e)');
    await form.getByLabel(/Date/).fill('2026-11-05');
    const log = apiLog(page);
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(form.getByRole('status')).toHaveText('Added to the maintenance log.');
    await expect(panel(page).getByText(/Cleaned the filter \(e2e\)/)).toBeVisible();
    expect(readFileSync(join(dataDir, 'House/Kitchen/Dishwasher.md'), 'utf8')).toContain(
      '- 2026-11-05 Cleaned the filter (e2e)',
    );
    // The item.changed for our own write carries the etag we already hold: ignored.
    await page.waitForTimeout(1_500);
    expect(log).toEqual([`POST /api/items/${DISHWASHER}/log`]);
    await expectNoA11yViolations(page);
  });
  test('after an entry, an item with a check interval is offered its next check (D39)', async ({
    page,
    backend,
  }) => {
    // Living room AC: next_check 2026-11-20, check_every 1y.
    const AC = 'it_3a9c4l';
    const note = 'House/Living room/Living room AC.md';
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    await page.goto(`${url}/i/${AC}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const form = panel(page).getByRole('form', { name: 'Add to maintenance log' });
    await form.getByLabel('Maintenance log entry').fill('Serviced, filters cleaned (e2e)');
    await form.getByLabel(/Date/).fill('2026-11-25');
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(form.getByRole('status')).toHaveText(
      'Added to the maintenance log. Set the next check to 25 Nov 2027?',
    );
    await expectNoA11yViolations(page);
    await form.getByRole('button', { name: 'Set next check to 25 Nov 2027' }).click();
    await expect(form.getByRole('status')).toHaveText('Next check set to 25 Nov 2027.');
    const text = readFileSync(join(dataDir, note), 'utf8');
    expect(text).toContain('next_check: 2027-11-25');
    expect(text).toContain('- 2026-11-25 Serviced, filters cleaned (e2e)');
    expect(text).toContain('check_every: 1y');
  });
});

test('a Markdown chunk that failed once loads on the next note opened (no reload)', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/assets/MarkdownBody-*.js', (r) => (fail ? r.abort() : r.fallback()));
  await page.goto(`/i/${DISHWASHER}`);
  const notes = panel(page).getByRole('region', { name: 'Notes' });
  await expect(notes.locator('.md-plain')).toContainText('**E15**');
  fail = false;
  await panel(page).getByRole('button', { name: 'Close details' }).click();
  await item(page, FRIDGE).click();
  await expect(panel(page).getByRole('heading', { name: 'Fridge' })).toBeVisible();
  await expect(notes.locator('.md-plain')).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Close details' }).click();
  await item(page, DISHWASHER).click();
  await expect(notes.getByRole('heading', { name: 'Quick help' })).toBeVisible();
});
