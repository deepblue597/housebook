/**
 * Second pass after the FE-01…FE-08 fixes: regressions and bypasses around each fix (keyboard-only
 * dialogs, refresh during a gesture, every house.json problem type, clipboard refused, link
 * tricks, two-finger gestures), plus the backend's PDF sandbox.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  FRIDGE,
  exampleHouse,
  expect,
  gotoPlan,
  item,
  panel,
  planView,
  searchBox,
  test,
} from './support/fixtures';

/** Edit a file under the data root and refetch on focus until a 200 arrives. */
async function editAndRefetch(page: Page, file: string, from: string, to: string) {
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  await expect
    .poll(
      async () => {
        const res = page.waitForResponse('**/api/snapshot');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return (await res).status();
      },
      { timeout: 10_000 },
    )
    .toBe(200);
}

// ---- FE-03 -------------------------------------------------------------------------------

test.describe('FE-03 probes: dialog focus return', () => {
  test('keyboard only: Enter opens, Esc closes, focus is back on the button', async ({ page }) => {
    await gotoPlan(page, `/i/${DISHWASHER}`);
    for (const name of ['Preview receipt.png', 'View manual.pdf']) {
      const open = panel(page).getByRole('button', { name });
      await open.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Focus is trapped inside the modal.
      await expect
        .poll(() => dialog.evaluate((d) => d.contains(document.activeElement)))
        .toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();
      await expect(panel(page)).toBeVisible();
    }
  });

  test('Close button pressed with the keyboard returns focus', async ({ page }) => {
    await gotoPlan(page, `/i/${DISHWASHER}`);
    const open = panel(page).getByRole('button', { name: 'Preview receipt.png' });
    await open.focus();
    await page.keyboard.press('Enter');
    const close = page.getByRole('dialog').getByRole('button', { name: 'Close' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('backdrop click closes and returns focus', async ({ page }) => {
    await gotoPlan(page, `/i/${DISHWASHER}`);
    const open = panel(page).getByRole('button', { name: 'View manual.pdf' });
    await open.click();
    await expect(page.getByRole('dialog').getByText('Page 1 of 1')).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(open).toBeFocused();
    // A second Esc now closes the panel, as usual.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });

  test('closing after the panel switched items does not throw or steal focus', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoPlan(page, `/i/${DISHWASHER}`);
    await panel(page).getByRole('button', { name: 'Preview receipt.png' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Back navigation while the modal is open unmounts the panel and the dialog together.
    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// ---- FE-04 / FE-05 -----------------------------------------------------------------------

test.describe('FE-04/05 probes: refresh during interaction', () => {
  test('a refresh landing mid-drag neither jumps the plan nor ends the drag', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
    await gotoPlan(page, `${url}/`);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const before = await planView(page);
    const vp = (await page.locator('.viewport').boundingBox())!;
    const start = { x: vp.x + 20, y: vp.y + 20 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 30, start.y + 10, { steps: 4 });
    await editAndRefetch(
      page,
      join(dataDir, 'House/Kitchen/Fridge.md'),
      'name: Fridge',
      'name: Fridge 2',
    );
    await expect(item(page, FRIDGE)).toHaveAttribute('aria-label', /^Fridge 2/);
    await page.mouse.move(start.x + 60, start.y + 20, { steps: 4 });
    await page.mouse.up();
    const after = await planView(page);
    expect(after.k).toBe(before.k);
    expect(after.tx - before.tx).toBeCloseTo(60, 0);
    expect(after.ty - before.ty).toBeCloseTo(20, 0);
    await expect(panel(page)).toBeHidden();
  });

  test('focus on a plan item survives a refresh while the panel is open', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
    await gotoPlan(page, `${url}/i/${DISHWASHER}`);
    await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeFocused();
    await item(page, FRIDGE).focus();
    await editAndRefetch(page, join(dataDir, 'House/Kitchen/Dishwasher.md'), '**E15**', '**E99**');
    await expect(panel(page).getByText('E99', { exact: true })).toBeVisible();
    await expect(item(page, FRIDGE)).toBeFocused();
  });

  test('a refresh that changes the grid size refits; one that does not keeps the zoom', async ({
    page,
    backend,
  }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
    await gotoPlan(page, `${url}/`);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const fitted = await planView(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    const zoomed = await planView(page);
    const houseFile = join(dataDir, 'house.json');
    const house = exampleHouse();
    // Same grid, different room name: zoom kept.
    house.rooms[0]!.name = 'Lounge';
    writeFileSync(houseFile, JSON.stringify({ ...house, $schema: undefined, schemaVersion: 1 }));
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          return page.locator('.plan [data-room-id="rm_liv"]').textContent();
        },
        { timeout: 10_000 },
      )
      .toMatch(/Lounge/);
    expect(await planView(page)).toEqual(zoomed);
    // Much wider grid (width-limited): the old fit no longer applies, so it refits.
    writeFileSync(
      houseFile,
      JSON.stringify({
        ...house,
        $schema: undefined,
        schemaVersion: 1,
        grid: { ...house.grid, width: 40 },
      }),
    );
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          return (await planView(page)).k;
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(fitted.k);
  });
});

test.describe('FE-05 probe on a phone @phone', () => {
  test('a refresh landing mid-pinch keeps the gesture continuous', async ({ page, backend }) => {
    const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
    await gotoPlan(page, `${url}/`);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const vp = (await page.locator('.viewport').boundingBox())!;
    const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
    const before = await planView(page);
    await send('touchStart', [
      { x: c.x - 40, y: c.y },
      { x: c.x + 40, y: c.y },
    ]);
    await send('touchMove', [
      { x: c.x - 60, y: c.y },
      { x: c.x + 60, y: c.y },
    ]);
    await editAndRefetch(
      page,
      join(dataDir, 'House/Kitchen/Fridge.md'),
      'name: Fridge',
      'name: Fridge 3',
    );
    await send('touchMove', [
      { x: c.x - 80, y: c.y },
      { x: c.x + 80, y: c.y },
    ]);
    await send('touchEnd', []);
    await expect.poll(async () => (await planView(page)).k / before.k).toBeCloseTo(2, 1);
  });

  test('pinch anchor drift is gone; a stationary thumb still zooms', async ({ page }) => {
    await gotoPlan(page);
    await expect.poll(async () => (await planView(page)).k).not.toBe(1);
    const vp = (await page.locator('.viewport').boundingBox())!;
    const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const send = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      pts: { x: number; y: number; id: number }[],
    ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const mid = await planView(page);
    const local = { x: c.x - vp.x, y: c.y - vp.y };
    const planPt = { x: (local.x - mid.tx) / mid.k, y: (local.y - mid.ty) / mid.k };
    await send('touchStart', [
      { x: c.x - 40, y: c.y, id: 0 },
      { x: c.x + 40, y: c.y, id: 1 },
    ]);
    for (let i = 1; i <= 5; i++) {
      await send('touchMove', [
        { x: c.x - 40 - 8 * i, y: c.y, id: 0 },
        { x: c.x + 40 + 8 * i, y: c.y, id: 1 },
      ]);
    }
    await expect.poll(async () => (await planView(page)).k / mid.k).toBeCloseTo(2, 1);
    const end = await planView(page);
    expect(Math.abs(end.tx + planPt.x * end.k - local.x)).toBeLessThan(1.5);
    expect(Math.abs(end.ty + planPt.y * end.k - local.y)).toBeLessThan(1.5);
    await send('touchEnd', []);
    // A stationary thumb and a moving finger still zoom (Chrome sends no pointermove for the
    // finger that doesn't move).
    const k0 = (await planView(page)).k;
    await send('touchStart', [
      { x: c.x - 40, y: c.y, id: 0 },
      { x: c.x + 40, y: c.y, id: 1 },
    ]);
    for (let i = 1; i <= 4; i++) {
      await send('touchMove', [
        { x: c.x - 40, y: c.y, id: 0 },
        { x: c.x + 40 + 20 * i, y: c.y, id: 1 },
      ]);
    }
    await send('touchEnd', []);
    await expect.poll(async () => (await planView(page)).k / k0).toBeCloseTo(2, 1);
    // (A tap right after a synthetic CDP pinch is sometimes swallowed by Chromium itself, with
    // no click reaching the document; tap-after-pinch is covered in plan.spec.ts.)
  });
});

// ---- FE-06 -------------------------------------------------------------------------------

const banner = (page: Page) => page.locator('.banner[role="note"]');
const HOUSE_CASES: { name: string; house: string; text: RegExp; reason: string }[] = [
  {
    name: 'newer schema',
    house: JSON.stringify({ ...exampleHouse(), schemaVersion: 3 }),
    text: /newer Housebook version \(schema 3\)/,
    reason: 'newer_version',
  },
  {
    name: 'newer schema this image cannot display',
    house: JSON.stringify({ schemaVersion: 2, grid: 'nope' }),
    text: /newer Housebook version \(schema 2\)/,
    reason: 'newer_version',
  },
  {
    name: 'JSON syntax error',
    house: '{ "schemaVersion": 1, ',
    text: /house\.json is not valid JSON/,
    reason: 'not_json',
  },
  {
    name: 'missing schemaVersion',
    house: JSON.stringify({ grid: { tileSize: 1, width: 4, depth: 4 } }),
    text: /missing or unsupported schemaVersion/,
    reason: 'bad_version',
  },
  {
    name: 'schemaVersion as a string',
    house: JSON.stringify({ ...exampleHouse(), schemaVersion: '1' }),
    text: /missing or unsupported schemaVersion/,
    reason: 'bad_version',
  },
  {
    name: 'invalid structure',
    house: JSON.stringify({ schemaVersion: 1, grid: 'nope' }),
    text: /house\.json is not valid/,
    reason: 'invalid',
  },
];

for (const c of HOUSE_CASES) {
  test(`FE-06 probe: read-only banner names the cause: ${c.name}`, async ({ page, backend }) => {
    const { url } = await backend({ house: c.house });
    await page.goto(`${url}/`);
    await expect(banner(page)).toHaveAttribute('data-reason', c.reason);
    await expect(banner(page)).toContainText(c.text);
    if (c.reason !== 'newer_version') await expect(banner(page)).not.toContainText(/newer/);
  });
}

test('FE-06 probe: a house.json that breaks after loading keeps the plan and says why', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await gotoPlan(page, `${url}/`);
  writeFileSync(join(dataDir, 'house.json'), '{ broken');
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return banner(page).count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect(banner(page)).toHaveAttribute('data-reason', 'not_json');
  await expect(banner(page)).toContainText('last valid version');
  await expect(page.locator('.plan [data-item-id]')).toHaveCount(13);
});

test('FE-09: an unreadable house.json is reported as unreadable, not as invalid', async ({
  page,
  backend,
}) => {
  const { url, dataDir } = await backend({}, { HOUSEBOOK_RESCAN_INTERVAL: '0.2' });
  await gotoPlan(page, `${url}/`);
  const file = join(dataDir, 'house.json');
  chmodSync(file, 0o000);
  try {
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          return banner(page).count();
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    await expect(banner(page)).toHaveAttribute('data-reason', 'unreadable');
    await expect(banner(page)).toContainText(
      /can.t be read|cannot be read|unreadable|permission/i,
      {
        timeout: 1_000,
      },
    );
    await expect(banner(page)).not.toContainText('is not valid');
  } finally {
    chmodSync(file, 0o644);
  }
});

test('FE-06 probe: if /api/problems fails the banner still says read-only', async ({
  page,
  backend,
}) => {
  const { url } = await backend({ house: JSON.stringify({ schemaVersion: 1, grid: 'nope' }) });
  await page.route('**/api/problems', (r) => r.fulfill({ status: 500, body: 'x' }));
  await page.goto(`${url}/`);
  await expect(banner(page)).toHaveText('The house layout is read-only.');
});

// ---- FE-02 / FE-08 -----------------------------------------------------------------------

test('FE-02 probes: Esc keeps the query highlighted; Esc with an empty query is harmless', async ({
  page,
}) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await searchBox(page).fill('e15');
  await searchBox(page).press('Escape');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeHidden();
  await expect(searchBox(page)).toHaveValue('e15');
  await expect(page.locator('.plan .badge.dim')).toHaveCount(12); // still filtering the plan
  // ArrowDown reopens it.
  await searchBox(page).press('ArrowDown');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await searchBox(page).press('Escape');
  await searchBox(page).press('Escape');
  await expect(searchBox(page)).toHaveValue('');
  await expect(page.locator('.plan .badge.dim')).toHaveCount(0);
  // Empty query: Esc does nothing visible and never closes the panel.
  await searchBox(page).press('Escape');
  await expect(searchBox(page)).toHaveValue('');
  await expect(searchBox(page)).toBeFocused();
  await expect(panel(page)).toBeVisible();
});

test('FE-08 probe: ArrowUp wraps to the last option and it is visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoPlan(page);
  await searchBox(page).fill('e');
  const options = page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
  await expect(options).toHaveCount(8);
  await searchBox(page).press('ArrowUp');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => {
      const o = (await options.last().boundingBox())!;
      const b = (await page.locator('.search .results').boundingBox())!;
      return o.y + o.height <= b.y + b.height + 0.5;
    })
    .toBe(true);
  // ...and back to the first.
  await searchBox(page).press('ArrowDown');
  await expect
    .poll(async () => {
      const o = (await options.first().boundingBox())!;
      const b = (await page.locator('.search .results').boundingBox())!;
      return o.y >= b.y - 0.5;
    })
    .toBe(true);
});

// ---- Copy path ---------------------------------------------------------------------------

test('Copy path: a refused clipboard falls back to selecting the path', async ({ page }) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () =>
      Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
  });
  await panel(page).getByRole('button', { name: 'Copy path' }).click();
  await expect(
    panel(page)
      .getByRole('status')
      .filter({ hasText: /Selected/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'House/Kitchen/Dishwasher.md',
  );
  // The selection didn't move focus out of the panel.
  await expect(panel(page).getByRole('button', { name: 'Copy path' })).toBeFocused();
});

test('Find manual online is not offered without brand or model', async ({ page, backend }) => {
  const { url } = await backend({
    files: {
      'House/Bare.md':
        '---\nhousebook_id: it_bare01\ntype: other\nname: Bare thing\ntags: [housebook]\n---\n',
    },
  });
  await page.goto(`${url}/i/it_bare01`);
  await expect(panel(page).getByRole('heading', { name: 'Bare thing' })).toBeVisible();
  await expect(panel(page).getByRole('link', { name: 'Find manual online' })).toHaveCount(0);
});

// ---- link tricks -------------------------------------------------------------------------

const TRICKS = `---
housebook_id: it_trick1
type: other
name: Trick links
manual: "/\\\\evil.example/manual"
support: "//javascript:alert(1)"
tags: [housebook]
---
- [pr](//evil.example/a)
- [bs1](/\\evil.example/b)
- [bs2](\\\\evil.example/c)
- [js-pr](//javascript:alert(1))
- [ent-tab](jav&#x09;ascript:window.__pwned=1)
- [ent-j](&#106;avascript:window.__pwned=2)
- [ent-colon](javascript&colon;window.__pwned=3)
- [nl](<java
script:window.__pwned=4>)
- [ctl](%01javascript:window.__pwned=5)
- [pct](java%73cript:window.__pwned=6)
- [up](JAVASCRIPT:window.__pwned=7)
- [in-app](/i/${DISHWASHER})
`;

test('link tricks: nothing runs, and every off-site link opens in a new tab', async ({
  page,
  backend,
}) => {
  const { url } = await backend({ files: { 'House/Trick links.md': TRICKS } });
  await page.route('**/evil.example/**', (r) => r.abort());
  await page.goto(`${url}/i/it_trick1`);
  const d = panel(page);
  await expect(d.getByRole('link', { name: 'in-app' })).toBeVisible();
  const links = await d.locator('a[href]').evaluateAll((as) =>
    as.map((a) => ({
      text: a.textContent,
      protocol: (a as HTMLAnchorElement).protocol,
      origin: (a as HTMLAnchorElement).origin,
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel') ?? '',
    })),
  );
  const origin = new URL(url).origin;
  for (const l of links) {
    // An unparseable href (protocol ":", e.g. //javascript:alert(1)) goes nowhere when clicked.
    if (l.protocol === ':') continue;
    expect(['http:', 'https:', 'mailto:', 'tel:', 'obsidian:'], JSON.stringify(l)).toContain(
      l.protocol,
    );
    if ((l.protocol === 'http:' || l.protocol === 'https:') && l.origin !== origin) {
      expect(l.target, `off-site link in the app tab: ${JSON.stringify(l)}`).toBe('_blank');
      expect(l.rel).toContain('noopener');
    }
  }
  // Click every link that stayed a link; nothing may execute.
  for (const name of ['js-pr', 'ent-tab', 'ent-j', 'ent-colon', 'nl', 'ctl', 'pct', 'up']) {
    const a = d.getByRole('link', { name, exact: true });
    if (await a.count()) await a.click({ modifiers: ['Control'] }).catch(() => undefined);
  }
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
});

// ---- backend changes: PDF under CSP sandbox ----------------------------------------------

test('PDFs are served sandboxed and the in-app viewer still renders them @smoke', async ({
  page,
}) => {
  await gotoPlan(page, `/i/${DISHWASHER}`);
  const res = await page.request.get('/api/items/it_7f3k2a/attachments/manual.pdf');
  expect(res.headers()['content-security-policy']).toMatch(/sandbox/);
  expect(res.headers()['content-type']).toBe('application/pdf');
  await panel(page).getByRole('button', { name: 'View manual.pdf' }).click();
  const dialog = page.getByRole('dialog', { name: 'manual.pdf' });
  await expect(dialog.getByText('Page 1 of 1')).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('two fingers down, one lifts: the other continues as a pan with no jump @phone', async ({
  page,
}) => {
  await gotoPlan(page);
  await expect.poll(async () => (await planView(page)).k).not.toBe(1);
  const vp = (await page.locator('.viewport').boundingBox())!;
  const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
  // CDP can't release one touch of several, so dispatch the pointer events directly.
  const ptr = (type: string, id: number, x: number, y: number) =>
    page.locator('.viewport').evaluate(
      (el, a) =>
        el.dispatchEvent(
          new PointerEvent(a.type, {
            pointerId: a.id,
            pointerType: 'touch',
            isPrimary: a.id === 1,
            clientX: a.x,
            clientY: a.y,
            bubbles: true,
            cancelable: true,
          }),
        ),
      { type, id, x, y },
    );
  const k0 = (await planView(page)).k;
  await ptr('pointerdown', 1, c.x - 40, c.y);
  await ptr('pointerdown', 2, c.x + 40, c.y);
  await ptr('pointermove', 1, c.x - 60, c.y);
  await ptr('pointermove', 2, c.x + 60, c.y);
  // Finger distance 80 → 120: wait until the frame with both moves has been applied.
  await expect.poll(async () => (await planView(page)).k / k0).toBeCloseTo(1.5, 5);
  const pinched = await planView(page);
  await ptr('pointerup', 2, c.x + 60, c.y);
  const lifted = await planView(page);
  expect(lifted).toEqual(pinched);
  await ptr('pointermove', 1, c.x - 30, c.y + 10);
  await expect.poll(async () => (await planView(page)).tx - lifted.tx).toBeCloseTo(30, 0);
  const panned = await planView(page);
  expect(panned.ty - lifted.ty).toBeCloseTo(10, 0);
  expect(panned.k).toBe(lifted.k);
  await ptr('pointerup', 1, c.x - 30, c.y + 10);
});
