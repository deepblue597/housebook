/**
 * Offline (milestone 12, D47): the service worker keeps the app, the app keeps the data, and
 * "Where is the main water valve?" still works when the server doesn't.
 */
import type { Page } from '@playwright/test';
import { DISHWASHER, expect, panel, planItems, test } from './support/fixtures';

test.use({ serviceWorkers: 'allow' });

/** The page is controlled by the service worker and the offline copy of the data is saved. */
async function readyForOffline(page: Page) {
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const c = await caches.open('housebook-data');
          return !!(await c.match('/offline/snapshot.json'));
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

const offlineBanner = (page: Page) => page.locator('.banner[data-reason="offline"]');

test('with the server down, the app opens from its saved copy, read-only', async ({
  page,
  backend,
}) => {
  const { url, stop } = await backend({}, { HOUSEBOOK_ANON_ROLE: 'editor' });
  await page.goto(`${url}/`);
  await expect(planItems(page)).toHaveCount(13);
  await expect(page.getByRole('button', { name: /^Edit/ })).toBeVisible();
  await readyForOffline(page);

  await stop();
  // A QR sticker scanned during a power cut: a deep link, loaded fresh.
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'cached');
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await expect(planItems(page)).toHaveCount(13);
  await expect(offlineBanner(page)).toContainText(/^Offline, data from \d/);
  // Editing is online only: who may edit isn't known without the server.
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);

  // Search and the list run on the saved data too.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Dishwasher');
});

test('a login that sends the page to an unreachable provider still opens the saved app', async ({
  page,
  context,
  backend,
}) => {
  const { url } = await backend();
  await page.goto(`${url}/`);
  await expect(planItems(page)).toHaveCount(13);
  await readyForOffline(page);

  // The proxy's session expired and the provider is down: page loads redirect to nowhere,
  // the API answers 401. `context.route` also sees the service worker's own requests.
  await context.route(
    (u) => u.origin === url && !u.pathname.startsWith('/assets/') && u.pathname !== '/sw.js',
    (r) =>
      r.request().isNavigationRequest() && !new URL(r.request().url()).searchParams.has('signin')
        ? r.fulfill({ status: 302, headers: { Location: 'http://127.0.0.1:9/auth' } })
        : r.fulfill({ status: 401, body: '{}' }),
  );
  let loads = 0;
  page.on('load', () => (loads += 1));
  await page.goto(`${url}/`);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'cached');
  await expect(planItems(page)).toHaveCount(13);
  const banner = page.locator('.banner[data-reason="signed_out"]');
  await expect(banner).toContainText('Your login has expired; showing data from', {
    timeout: 15_000,
  });
  // No automatic reload to a login page that can't load: the data stays on screen.
  await page.waitForTimeout(1_000);
  expect(loads).toBe(1);
  await expect(banner.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
    'href',
    `${url}/?signin=1`,
  );
});

test('signing in again returns without ?signin in the address', async ({ page, backend }) => {
  const { url } = await backend();
  await page.goto(`${url}/i/${DISHWASHER}?signin=1`);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});
