/**
 * Independent verification of milestone 4 on the client (live sync, fallback, problems panel,
 * maintenance log, ghost/stale states). Every test runs against a real backend on its own temp
 * copy of examples/house. Known bugs are `test.fail()` with a `M4V-NN` id: when one starts
 * passing, Playwright reports it — drop the `test.fail` line then.
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request,
} from 'node:http';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  FRIDGE,
  expect,
  expectNoA11yViolations,
  gotoPlan,
  item,
  panel,
  test,
} from '../support/fixtures';
import { EXAMPLE, freePort, makePdf } from '../support/server';

const sync = (page: Page) => page.locator('[data-sync]');
const badge = (page: Page) => page.getByRole('button', { name: /data problems?\. Show/ });
const fast = { reconnectMs: 200, pollMs: 500, sseRetryMs: 1_500, resyncTimeoutMs: 1_000 };
const setTimings = (page: Page, t: Record<string, number> = fast) =>
  page.addInitScript((x) => {
    (window as { __housebookSyncTimings?: unknown }).__housebookSyncTimings = x;
  }, t);

function edit(dir: string, rel: string, from: string, to: string) {
  const file = join(dir, rel);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
}

/** Console errors, page errors (incl. unhandled rejections) and /api requests from now on. */
function watch(page: Page) {
  const errors: string[] = [];
  const api: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) api.push(`${r.method()} ${u.pathname}`);
  });
  return { errors, api };
}

/** Record every data-sync value the indicator takes (MutationObserver in the page). */
async function recordSync(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-sync]')!;
    const w = window as unknown as { __syncLog: string[] };
    w.__syncLog = [el.getAttribute('data-sync')!];
    new MutationObserver(() => {
      const v = el.getAttribute('data-sync')!;
      if (w.__syncLog.at(-1) !== v) w.__syncLog.push(v);
    }).observe(el, { attributes: true, attributeFilter: ['data-sync'] });
  });
  return () => page.evaluate(() => (window as unknown as { __syncLog: string[] }).__syncLog);
}

/** Flag if any element matching `selector` ever shows up (MutationObserver). */
async function neverSeen(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __seen: Record<string, boolean> };
    w.__seen ??= {};
    w.__seen[sel] = !!document.querySelector(sel);
    new MutationObserver(() => {
      if (document.querySelector(sel)) w.__seen[sel] = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  }, selector);
  return () =>
    page.evaluate(
      (sel) => (window as unknown as { __seen: Record<string, boolean> }).__seen[sel],
      selector,
    );
}

const problemCount = async (url: string) =>
  ((await (await fetch(`${url}/api/problems`)).json()) as { count: number }).count;

// ------------------------------------------------------------------------------------------

test.describe('external edits while the page is open', () => {
  test('rename (delete + create): path follows, no ghost flash, no reload', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    const w = watch(page);
    await page.goto(`${url}/i/${FRIDGE}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const ghostEver = await neverSeen(page, `[data-ghost-id="${FRIDGE}"]`);
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    w.api.length = 0;
    renameSync(
      join(dataDir, 'House/Kitchen/Fridge.md'),
      join(dataDir, 'House/Kitchen/Fridge (old).md'),
    );
    await expect(panel(page).locator('.note-foot code')).toHaveText(
      'House/Kitchen/Fridge (old).md',
      {
        timeout: 10_000,
      },
    );
    expect(await ghostEver()).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );
    expect(w.api).not.toContain('GET /api/snapshot');
    expect(w.errors).toEqual([]);
  });

  test('half-written YAML fixed within the re-check window never flags stale', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const staleEver = await neverSeen(page, `.plan [data-item-id="${DISHWASHER}"].stale`);
    const file = join(dataDir, 'House/Kitchen/Dishwasher.md');
    const full = readFileSync(file, 'utf8');
    writeFileSync(file, full.slice(0, 60)); // a sync tool mid-write
    await new Promise((r) => setTimeout(r, 300)); // the writer finishing, not a wait on the app
    writeFileSync(file, full.replace('**E15**', '**E77**'));
    await expect(panel(page).getByText('E77', { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(await staleEver()).toBe(false);
  });

  test('stale → fixed: marker, notice, badge and log form all recover', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    const w = watch(page);
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const form = panel(page).getByRole('form', { name: 'Add to maintenance log' });
    await expect(form).toBeVisible();
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: Dishwasher', 'name: [unclosed');
    await expect(item(page, DISHWASHER)).toHaveClass(/stale/);
    await expect(form).toHaveCount(0);
    await expect(panel(page)).toContainText('Log entries can be added again');
    await expect(badge(page)).toBeVisible();
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: [unclosed', 'name: Dishwasher');
    await expect(item(page, DISHWASHER)).not.toHaveClass(/stale/);
    await expect(panel(page).getByRole('note')).toHaveCount(0);
    await expect(form).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    expect(w.errors).toEqual([]);
  });

  test('sync-conflict copy: badge count matches /api/problems, item not duplicated', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await expect(badge(page)).toHaveCount(0);
    const copy = 'House/Kitchen/Dishwasher.sync-conflict-20261106-120000-ABCDEFG.md';
    copyFileSync(join(dataDir, 'House/Kitchen/Dishwasher.md'), join(dataDir, copy));
    await expect(badge(page)).toBeVisible({ timeout: 10_000 });
    const n = await problemCount(url);
    expect(n).toBeGreaterThan(0);
    await expect(badge(page)).toHaveAccessibleName(new RegExp(`^${n} data problem`));
    await expect(page.locator(`.plan [data-item-id="${DISHWASHER}"]`)).toHaveCount(1);
    const path = await page.evaluate(
      (id) =>
        (
          window as unknown as {
            __housebook: {
              data: { getState(): { model: { items: Map<string, { path: string }> } } };
            };
          }
        ).__housebook.data
          .getState()
          .model.items.get(id)!.path,
      DISHWASHER,
    );
    expect(path).toBe('House/Kitchen/Dishwasher.md');
    await badge(page).click();
    const dialog = page.getByRole('dialog', { name: 'Data problems' });
    await expect(dialog).toContainText(copy);
    await page.keyboard.press('Escape');
    rmSync(join(dataDir, copy));
    await expect(badge(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test('attachment file added and removed: panel follows with one item fetch', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    const w = watch(page);
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const atts = panel(page).getByRole('region', { name: 'Attachments' });
    await expect(atts).toContainText('receipt.png');
    w.api.length = 0;
    writeFileSync(join(dataDir, 'House/Kitchen/Dishwasher/warranty.pdf'), makePdf(['W']));
    await expect(atts).toContainText('warranty.pdf');
    rmSync(join(dataDir, 'House/Kitchen/Dishwasher/receipt.png'));
    await expect(atts).not.toContainText('receipt.png');
    expect(w.api.filter((r) => r === `GET /api/items/${DISHWASHER}`).length).toBeGreaterThan(0);
    expect(w.api).not.toContain('GET /api/snapshot');
    expect(w.errors).toEqual([]);
  });
});

test.describe('two browser contexts', () => {
  test('a log entry added in one context appears in the other without reload', async ({
    browser,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    const wa = watch(a);
    const wb = watch(b);
    for (const p of [a, b]) {
      await p.goto(`${url}/i/${DISHWASHER}`);
      await expect(sync(p)).toHaveAttribute('data-sync', 'live');
    }
    const form = panel(a).getByRole('form', { name: 'Add to maintenance log' });
    await form.getByLabel('Maintenance log entry').fill('Two-context entry');
    await form.getByLabel('Maintenance log entry').press('Enter'); // keyboard submit
    await expect(form.getByRole('status')).toHaveText('Added to the maintenance log.');
    await expect(panel(b).getByText(/Two-context entry/)).toBeVisible();
    expect(readFileSync(join(dataDir, 'House/Kitchen/Dishwasher.md'), 'utf8')).toContain(
      'Two-context entry',
    );
    // Other context: one item fetch, no snapshot.
    expect(wb.api.filter((r) => r === 'GET /api/snapshot').length).toBe(1); // first load only
    expect(wa.errors.concat(wb.errors)).toEqual([]);
    await a.context().close();
    await b.context().close();
  });
});

// ---- a reverse proxy in front of the backend, to break /api/events on purpose ---------------

type Mode = 'pass' | 'hold' | 'drop' | 'down' | 'mute';
async function proxy(target: string) {
  const port = await freePort();
  const state = { mode: 'pass' as Mode, events: 0, open: new Set<ServerResponse>(), target };
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (state.mode === 'down') {
      // The backend is gone; the proxy answers 502 to everything (static files too).
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
      return;
    }
    if (req.url?.startsWith('/api/events')) {
      state.events += 1;
      if (state.mode === 'hold') {
        // A buffering proxy: 200 + headers, then nothing.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.flushHeaders();
        state.open.add(res);
        res.on('close', () => state.open.delete(res));
        return;
      }
      if (state.mode === 'drop') {
        req.socket.destroy();
        return;
      }
    }
    const t = new URL(state.target);
    const up = request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        if (state.mode === 'mute' && req.url?.startsWith('/api/events')) {
          // Half-open: the first chunk (retry + resync) gets through, then nothing ever again.
          let open = true;
          r.on('data', (c: Buffer) => {
            if (open) res.write(c);
            if (c.toString().includes('event: resync')) open = false;
          });
        } else r.pipe(res);
        // Like nginx: an upstream that dies takes the downstream response with it.
        r.on('aborted', () => res.destroy());
        r.on('error', () => res.destroy());
        if (req.url?.startsWith('/api/events')) {
          state.open.add(res);
          res.on('close', () => state.open.delete(res));
        }
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise<void>((ok) => srv.listen(port, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    /** Cut every open event stream. */
    cut: () => {
      for (const r of state.open) r.socket?.destroy();
      state.open.clear();
    },
    close: () =>
      new Promise<void>((ok) => {
        for (const r of state.open) r.socket?.destroy();
        srv.closeAllConnections();
        srv.close(() => ok());
      }),
  };
}

test.describe('fallback and recovery', () => {
  test('buffering proxy (stream opens, no resync): counts as error → polling; fixed → live', async ({
    page,
    backend,
  }) => {
    const { url } = await backend();
    const px = await proxy(url);
    try {
      px.state.mode = 'hold';
      await setTimings(page);
      const w = watch(page);
      await gotoPlan(page, `${px.url}/`);
      const log = await recordSync(page);
      await expect(sync(page)).toHaveAttribute('data-sync', 'polling', { timeout: 10_000 });
      px.state.mode = 'pass';
      await expect(sync(page)).toHaveAttribute('data-sync', 'live', { timeout: 10_000 });
      // Request volume over the whole episode stays proportional to the timings.
      expect(w.api.length).toBeLessThan(60);
      expect(w.errors).toEqual([]);
      expect(await log()).toContain('polling');
    } finally {
      await px.close();
    }
  });

  test('stream cut mid-flight: reconnects and goes back to live, edits made meanwhile arrive', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    const px = await proxy(url);
    try {
      await setTimings(page);
      const w = watch(page);
      await gotoPlan(page, `${px.url}/`);
      await expect(sync(page)).toHaveAttribute('data-sync', 'live');
      px.state.mode = 'drop';
      px.cut();
      edit(dataDir, 'House/Kitchen/Fridge.md', 'name: Fridge', 'name: Offline fridge');
      await expect.poll(() => px.state.events).toBeGreaterThan(2);
      px.state.mode = 'pass';
      await expect(sync(page)).toHaveAttribute('data-sync', 'live', { timeout: 10_000 });
      await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Offline fridge/, {
        timeout: 10_000,
      });
      expect(w.errors.filter((e) => !/Failed to load resource|ERR_/.test(e))).toEqual([]);
    } finally {
      await px.close();
    }
  });

  test('backend down behind a proxy (502s) → Offline; back → Live, with changes made while down', async ({
    page,
    backend,
  }) => {
    test.setTimeout(90_000);
    // The backend can't be stopped cleanly while a stream is open (M4V-B1), so the outage is
    // simulated at the proxy: every request answers 502 and open streams are cut.
    const first = await backend();
    const dataDir = first.dataDir;
    const px = await proxy(first.url);
    try {
      await setTimings(page);
      const w = watch(page);
      await gotoPlan(page, `${px.url}/`);
      await expect(sync(page)).toHaveAttribute('data-sync', 'live');
      const log = await recordSync(page);
      px.state.mode = 'down';
      px.cut();
      await expect(sync(page)).toHaveAttribute('data-sync', 'offline', { timeout: 10_000 });
      await expect(sync(page)).toHaveAccessibleName(/can’t reach the server/);
      await expect(page.locator('.plan [data-item-id]').first()).toBeVisible();
      const nDown = w.api.length;
      edit(dataDir, 'House/Kitchen/Fridge.md', 'name: Fridge', 'name: Restarted fridge');
      px.state.mode = 'pass';
      await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Restarted fridge/, {
        timeout: 15_000,
      });
      await expect(sync(page)).toHaveAttribute('data-sync', 'live', { timeout: 15_000 });
      console.log('M4V sync transitions:', (await log()).join(' → '));
      console.log('M4V api requests: until offline', nDown, 'total', w.api.length);
      expect(w.errors.filter((e) => !/Failed to load resource|ERR_|502/.test(e))).toEqual([]);
    } finally {
      await px.close();
    }
  });

  test('M4V-01: after a suppressed auth reload, sync recovers once /api/me is OK again', async ({
    page,
    backend,
  }) => {
    const { url } = await backend();
    await setTimings(page);
    let unauthorized = true;
    // A realistic expired login: every API call answers 401 (the stream can't see it).
    await page.route(/\/api\/(me|snapshot)$/, (r) =>
      unauthorized ? r.fulfill({ status: 401, body: '{}' }) : r.fallback(),
    );
    await page.route('**/api/events', (r) => (unauthorized ? r.abort() : r.fallback()));
    let loads = 0;
    page.on('load', () => (loads += 1));
    await page.goto(`${url}/`);
    await expect.poll(() => loads, { timeout: 10_000 }).toBe(2);
    // (no data yet: the snapshot is 401 too)
    // Second page: the error → 401 → reload declined (less than a minute). Then login is fine.
    await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBeGreaterThan(0);
    await expect(sync(page)).toHaveAttribute('data-sync', 'signed_out', { timeout: 8_000 });
    await expect(sync(page)).toHaveAccessibleName(/login has expired/);
    unauthorized = false;
    // Expected: the client keeps retrying and reaches live (was: stuck on "Connecting").
    await expect(sync(page)).toHaveAttribute('data-sync', 'live', { timeout: 8_000 });
    await expect(page.locator('.plan [data-item-id]').first()).toBeVisible();
  });
});

test.describe('longer outage and hidden tab', () => {
  test('a 5 s outage: indicator transitions and request volume', async ({ page, backend }) => {
    const { url } = await backend();
    const px = await proxy(url);
    try {
      await setTimings(page);
      const w = watch(page);
      await gotoPlan(page, `${px.url}/`);
      await expect(sync(page)).toHaveAttribute('data-sync', 'live');
      const log = await recordSync(page);
      const n0 = w.api.length;
      px.state.mode = 'down';
      px.cut();
      await page.waitForTimeout(5_000); // the outage itself; we measure what the client does in it
      const during = w.api.slice(n0);
      px.state.mode = 'pass';
      await expect(sync(page)).toHaveAttribute('data-sync', 'live', { timeout: 10_000 });
      console.log('M4V outage transitions:', (await log()).join(' → '));
      const counts: Record<string, number> = {};
      for (const r of during) counts[r] = (counts[r] ?? 0) + 1;
      console.log('M4V outage requests (5 s, fast timings):', JSON.stringify(counts));
      // pollMs 500 + sseRetryMs 1500 → ~10 polls, ~3 stream tries, an /api/me per failure.
      expect(during.length).toBeLessThan(40);
    } finally {
      await px.close();
    }
  });

  test('hidden tab: stream closed after hiddenCloseMs, nothing polled; visible → reconnect + resync', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await setTimings(page, { ...fast, hiddenCloseMs: 500 });
    await page.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, 'visibilityState', {
        get: () => (hidden ? 'hidden' : 'visible'),
      });
      Object.defineProperty(document, 'hidden', { get: () => hidden });
      (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden = (h) => {
        hidden = h;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    });
    const w = watch(page);
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await page.evaluate(() =>
      (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(true),
    );
    await expect(sync(page)).toHaveAttribute('data-sync', 'connecting');
    const n = w.api.length;
    edit(dataDir, 'House/Kitchen/Fridge.md', 'name: Fridge', 'name: Hidden fridge');
    await page.waitForTimeout(2_000); // hidden period: measuring that nothing is requested
    expect(w.api.slice(n)).toEqual([]);
    await page.evaluate(() =>
      (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(false),
    );
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Hidden fridge/);
    console.log('M4V on visible:', w.api.slice(n).join(', '));
    expect(w.errors).toEqual([]);
  });
});

test.describe('watchdog', () => {
  test('stream stays open but goes silent (default timings): reconnect within ~45 s, back to live', async ({
    page,
    backend,
  }) => {
    test.setTimeout(120_000);
    const { url, dataDir } = await backend();
    const px = await proxy(url);
    try {
      px.state.mode = 'mute';
      const w = watch(page);
      await gotoPlan(page, `${px.url}/`);
      await expect(sync(page)).toHaveAttribute('data-sync', 'live');
      const t0 = Date.now();
      const log = await recordSync(page);
      expect(px.state.events).toBe(1);
      px.state.mode = 'pass';
      // An edit now is never delivered on the muted stream; the reconnect's resync brings it.
      edit(dataDir, 'House/Kitchen/Fridge.md', 'name: Fridge', 'name: Watchdog fridge');
      await expect.poll(() => px.state.events, { timeout: 60_000, intervals: [500] }).toBe(2);
      const dt = Date.now() - t0;
      console.log(`M4V watchdog reconnect after ${dt} ms; transitions`, (await log()).join(' → '));
      expect(dt).toBeGreaterThan(40_000);
      expect(dt).toBeLessThan(57_000); // 45 s watchdog + 5 s reconnect delay
      await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Watchdog fridge/);
      await expect(sync(page)).toHaveAttribute('data-sync', 'live');
      expect(w.errors).toEqual([]);
    } finally {
      await px.close();
    }
  });

  test('server ping keeps a quiet live stream alive past 45 s (no reconnect)', async ({
    page,
    backend,
  }) => {
    test.setTimeout(120_000);
    const { url } = await backend();
    const px = await proxy(url);
    try {
      await gotoPlan(page, `${px.url}/`);
      await expect(sync(page)).toHaveAttribute('data-sync', 'live');
      const log = await recordSync(page);
      await page.waitForTimeout(55_000); // measuring: idle beyond the watchdog window
      expect(px.state.events).toBe(1);
      expect(await log()).toEqual(['live']);
    } finally {
      await px.close();
    }
  });
});

test.describe('roles', () => {
  test('viewer: no log form, no Adopt, server refuses writes', async ({ page, backend }) => {
    const { url } = await backend({
      files: {
        'House/Kitchen/Kettle.md': '---\ntype: other\nname: Kettle\ntags: [housebook]\n---\n',
      },
    });
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
    await expect(page.locator('form.log-form, .log-form')).toHaveCount(0);
    await badge(page).click();
    const dialog = page.getByRole('dialog', { name: 'Data problems' });
    await expect(dialog.getByRole('heading', { name: /Notes not yet adopted/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Adopt' })).toHaveCount(0);
    const r = await page.request.post(`${url}/api/items/${DISHWASHER}/log`, {
      data: { text: 'x' },
    });
    expect(r.status()).toBe(403);
  });

  test('editor adopt: badge count tracks /api/problems; second tab sees the new item', async ({
    browser,
    backend,
  }) => {
    const { url } = await backend(
      {
        files: {
          'House/Kitchen/Kettle.md': '---\ntype: other\nname: Kettle\ntags: [housebook]\n---\n',
        },
      },
      { HOUSEBOOK_ANON_ROLE: 'editor' },
    );
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    for (const p of [a, b]) {
      await gotoPlan(p, `${url}/`);
      await expect(sync(p)).toHaveAttribute('data-sync', 'live');
    }
    const before = await problemCount(url);
    await expect(badge(a)).toHaveAccessibleName(new RegExp(`^${before} data`));
    await badge(a).click();
    await page_adopt(a);
    const after = await problemCount(url);
    expect(after).toBe(before - 1);
    for (const p of [a, b]) {
      if (after === 0) await expect(badge(p)).toHaveCount(0);
      else await expect(badge(p)).toHaveAccessibleName(new RegExp(`^${after} data`));
    }
    await b.getByRole('button', { name: 'List', exact: true }).click();
    await expect(b.getByRole('button', { name: /^Kettle/ })).toBeVisible();
    await a.context().close();
    await b.context().close();
  });
});

test('M4V-04: adopting the last problem, then closing the panel, leaves focus somewhere sensible', async ({
  page,
  backend,
}) => {
  const { url } = await backend(
    {
      files: {
        'House/Kitchen/Kettle.md': '---\ntype: other\nname: Kettle\ntags: [housebook]\n---\n',
      },
    },
    { HOUSEBOOK_ANON_ROLE: 'editor' },
  );
  await gotoPlan(page, `${url}/`);
  await expect(sync(page)).toHaveAttribute('data-sync', 'live');
  expect(await problemCount(url)).toBe(1);
  await badge(page).focus();
  await page.keyboard.press('Enter');
  await page_adopt(page);
  await expect.poll(() => problemCount(url)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Data problems' })).toHaveCount(0);
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? 'none');
  expect(focused).not.toBe('BODY');
});

async function page_adopt(p: Page) {
  const dialog = p.getByRole('dialog', { name: 'Data problems' });
  await dialog.getByRole('button', { name: 'Adopt' }).click();
  await expect(dialog.getByRole('status')).toHaveText(/Adopted House\/Kitchen\/Kettle\.md/);
}

test.describe('ghost and stale markers', () => {
  test('stale item in 3D gets a "?" badge; ghost labelled; badges do not overlap', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: Dishwasher', 'name: [unclosed');
    await expect(item(page, DISHWASHER)).toHaveClass(/stale/);
    rmSync(join(dataDir, 'House/Kitchen/Fridge.md'));
    await expect(page.locator(`.plan [data-ghost-id="${FRIDGE}"]`)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: '3D' }).click();
    await expect(page.locator('.scene3d')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator(`[data-anchor="stale:${DISHWASHER}"]`)).toHaveText('?');
    await expect(page.locator(`[data-anchor="ghost:${FRIDGE}"]`)).toHaveText('note missing');
  });

  test('stale item that also has a status: 3D "?" badge does not cover the status badge', async ({
    page,
    backend,
  }) => {
    // Make the dishwasher overdue (next_check in the past), then stale.
    const src = readFileSync(join(EXAMPLE, 'House/Kitchen/Dishwasher.md'), 'utf8');
    const { url, dataDir } = await backend({
      files: {
        'House/Kitchen/Dishwasher.md': src.replace(
          'tags: [housebook]',
          'next_check: 2020-01-01\ntags: [housebook]',
        ),
      },
    });
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    console.log(
      'M4V-02 status before stale:',
      await item(page, DISHWASHER).getAttribute('aria-label'),
    );
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: Dishwasher', 'name: [unclosed');
    await expect(item(page, DISHWASHER)).toHaveClass(/stale/);
    console.log(
      'M4V-02 status after stale:',
      await item(page, DISHWASHER).getAttribute('aria-label'),
    );
    await page.getByRole('button', { name: '3D' }).click();
    await expect(page.locator('.scene3d')).toHaveAttribute('data-ready', 'true');
    const s = await page.locator(`[data-anchor="stale:${DISHWASHER}"]`).boundingBox();
    const b = await page.locator(`[data-anchor="badge:${DISHWASHER}"]`).boundingBox();
    expect(s && b).toBeTruthy();
    const overlap =
      Math.max(0, Math.min(s!.x + s!.width, b!.x + b!.width) - Math.max(s!.x, b!.x)) *
      Math.max(0, Math.min(s!.y + s!.height, b!.y + b!.height) - Math.max(s!.y, b!.y));
    expect(overlap).toBe(0);
  });

  test('stale note body still renders as Markdown (not raw text) — open before and after', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    const notes = panel(page).getByRole('region', { name: 'Notes' });
    await expect(notes.getByRole('heading', { name: 'Quick help' })).toBeVisible();
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: Dishwasher', 'name: [unclosed');
    await expect(panel(page).getByRole('note')).toBeVisible();
    await expect(notes.getByRole('heading', { name: 'Quick help' })).toBeVisible();
    await expect(notes.locator('.md-plain')).toHaveCount(0);
    // Fresh page load on the already-stale item (snapshot carries the last good body).
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('note')).toBeVisible();
    await expect(notes.getByRole('heading', { name: 'Quick help' })).toBeVisible();
    await expect(notes.locator('.md-plain')).toHaveCount(0);
  });
});

test.describe('raw Markdown investigation (developer open note)', () => {
  test('stale note opened while the Markdown chunk is still loading: raw text only until it arrives', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend();
    edit(dataDir, 'House/Kitchen/Dishwasher.md', '## Notes', '## Notes\nfirst good');
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    await page.route('**/assets/MarkdownBody-*.js', async (r) => {
      await held;
      await r.fallback();
    });
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    edit(dataDir, 'House/Kitchen/Dishwasher.md', 'name: Dishwasher', 'name: [unclosed');
    await expect(item(page, DISHWASHER)).toHaveClass(/stale/);
    await item(page, DISHWASHER).click();
    const notes = panel(page).getByRole('region', { name: 'Notes' });
    await expect(notes.locator('.md-plain')).toContainText('**E15**'); // raw Markdown
    release();
    await expect(notes.getByRole('heading', { name: 'Quick help' })).toBeVisible();
    await expect(notes.locator('.md-plain')).toHaveCount(0);
  });

  test('Markdown chunk fails while offline: the renderer loads once the network is back (no reload)', async ({
    page,
    backend,
  }) => {
    const { url } = await backend();
    const w = watch(page);
    let fail = true;
    const tries: string[] = [];
    await page.route(/\/assets\/MarkdownBody-[^/]*\.js/, (r) => {
      tries.push(new URL(r.request().url()).search || '(plain)');
      return fail ? r.abort() : r.fallback();
    });
    await page.goto(`${url}/i/${DISHWASHER}`);
    const notes = panel(page).getByRole('region', { name: 'Notes' });
    await expect(notes.locator('.md-plain')).toContainText('**E15**');
    await expect.poll(() => tries.length).toBeGreaterThan(1); // one immediate retry
    const whileFailing = tries.length;
    fail = false;
    // Network back. Open another item in-app (no reload).
    await panel(page).getByRole('button', { name: 'Close details' }).click();
    await item(page, FRIDGE).click();
    await expect(panel(page).getByRole('heading', { name: 'Fridge' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close details' }).click();
    await item(page, DISHWASHER).click();
    await expect(notes.getByRole('heading', { name: 'Quick help' })).toBeVisible();
    await expect(notes.locator('.md-plain')).toHaveCount(0);
    console.log('M4V md chunk requests:', tries.join(', '), '| failing phase', whileFailing);
    console.log('M4V md errors:', w.errors.join(' | '));
    expect(tries.length).toBeLessThan(6); // no retry loop
    expect(w.errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  });
});

test.describe('keyboard, screen reader, phone', () => {
  test('problems dialog and log form by keyboard only', async ({ page, backend }) => {
    const { url } = await backend(
      {
        files: {
          'House/Kitchen/Kettle.md': '---\ntype: other\nname: Kettle\ntags: [housebook]\n---\n',
        },
      },
      { HOUSEBOOK_ANON_ROLE: 'editor' },
    );
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await expect(sync(page)).toHaveRole('status');
    await badge(page).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Data problems' });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(badge(page)).toBeFocused();

    const input = panel(page).getByLabel('Maintenance log entry');
    await input.focus();
    await page.keyboard.press('Enter'); // empty
    const status = panel(page)
      .getByRole('form', { name: 'Add to maintenance log' })
      .getByRole('status');
    await expect(status).toHaveText('Write what was done first.');
    await page.keyboard.type('Keyboard entry');
    const add = panel(page).getByRole('button', { name: 'Add', exact: true });
    // Tab through the date field (Chrome: month/day/year segments) to Add.
    for (let i = 0; i < 6 && !(await add.evaluate((b) => b === document.activeElement)); i++)
      await page.keyboard.press('Tab');
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Added to the maintenance log.');
    await expect(panel(page).getByText(/Keyboard entry/)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('phone 390×844: dot-only indicator keeps its text for SR, log form fits', async ({
    browser,
    backend,
  }) => {
    const { url } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    await page.goto(`${url}/i/${DISHWASHER}`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await expect(sync(page).locator('.label')).toBeHidden();
    await expect(sync(page).locator('.dot')).toBeVisible();
    await expect(sync(page)).toHaveAccessibleName(/live/i);
    const form = panel(page).getByRole('form', { name: 'Add to maintenance log' });
    await form.scrollIntoViewIfNeeded();
    await expect(form).toBeVisible();
    for (const el of [
      form.getByRole('button', { name: 'Add' }),
      form.getByLabel('Maintenance log entry'),
    ]) {
      const box = await el.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoA11yViolations(page);
    await ctx.close();
  });

  test('M4V-03: phone dot: Offline and Connecting differ by more than colour', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.plan')).toBeVisible();
    const style = (s: string) =>
      page.evaluate((st) => {
        const el = document.querySelector('[data-sync]')!;
        el.className = `sync ${st}`;
        const d = getComputedStyle(el.querySelector('.dot')!);
        return `${d.backgroundImage}|${d.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'none' : 'fill'}|${d.borderStyle}|${d.width}`;
      }, s);
    // Shape (not colour) per state: compare everything except colours, all pairs.
    const shape = (st: string) =>
      page.evaluate((x) => {
        const el = document.querySelector('[data-sync]')!;
        el.className = `sync ${x}`;
        const d = getComputedStyle(el.querySelector('.dot')!);
        const img = d.backgroundImage.replace(/rgba?\([^)]*\)/g, 'C');
        const filled = d.backgroundColor !== 'rgba(0, 0, 0, 0)';
        return `${img}|${filled}|${d.borderRadius}`;
      }, st);
    const states = ['live', 'polling', 'connecting', 'offline', 'signed_out'];
    const shapes = await Promise.all(states.map(shape));
    console.log('M4V-03 shapes:', states.map((st, i) => `${st}=${shapes[i]}`).join(' ; '));
    expect(new Set(shapes).size).toBe(states.length);
    expect(await style('offline')).not.toBe(await style('connecting'));
    await ctx.close();
  });
});

test.describe('quiet when idle', () => {
  test('live and idle for 8 s: no API traffic beyond the event stream', async ({
    page,
    backend,
  }) => {
    const { url } = await backend();
    const w = watch(page);
    await gotoPlan(page, `${url}/`);
    await expect(sync(page)).toHaveAttribute('data-sync', 'live');
    await expect.poll(() => w.api.includes('GET /api/me')).toBe(true);
    const n = w.api.length;
    await page.waitForTimeout(8_000); // measuring idle traffic: the wait is the measurement
    expect(w.api.slice(n)).toEqual([]);
    expect(w.errors).toEqual([]);
    console.log('M4V initial api requests:', w.api.slice(0, n).join(', '));
  });
});

// Unused import guard (mkdirSync kept for ad-hoc data edits).
void mkdirSync;
