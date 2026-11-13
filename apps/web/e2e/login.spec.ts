/**
 * The built-in login (HOUSEBOOK_AUTH_MODE=oidc, milestone 10, D48) against a fake provider.
 */
import type { Page } from '@playwright/test';
import { CLIENT_ID, CLIENT_SECRET, type FakeIdp, startFakeIdp } from './support/fakeIdp';
import { DISHWASHER, expect, openMore, panel, planItems, test } from './support/fixtures';

const ANNA = {
  sub: 'u-anna',
  preferred_username: 'anna',
  name: 'Anna',
  groups: ['/home/housebook-editors'],
};
const KID = { sub: 'u-kid', preferred_username: 'kid', name: 'Kid', groups: ['/home/family'] };

let idp: FakeIdp;
test.beforeAll(async () => {
  idp = await startFakeIdp([ANNA, KID]);
});
test.afterAll(() => idp.stop());

const oidcEnv = () => ({
  HOUSEBOOK_AUTH_MODE: 'oidc',
  HOUSEBOOK_PUBLIC_URL: '{url}',
  HOUSEBOOK_OIDC_ISSUER: idp.issuer,
  HOUSEBOOK_OIDC_CLIENT_ID: CLIENT_ID,
  HOUSEBOOK_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  HOUSEBOOK_EDITOR_GROUP: '/home/housebook-editors',
});

const editButton = (page: Page) => page.getByRole('button', { name: 'Edit', exact: true });

test('signing in goes to the provider and back to the page asked for; log out ends it', async ({
  page,
  backend,
}) => {
  const { url } = await backend({}, oidcEnv());
  await page.goto(`${url}/i/${DISHWASHER}`);
  await expect(page.getByRole('heading', { name: 'Fake login' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in as Anna' }).click();

  await expect(page).toHaveURL(`${url}/i/${DISHWASHER}`);
  await expect(panel(page).getByRole('heading', { name: 'Dishwasher' })).toBeVisible();
  await expect(planItems(page)).toHaveCount(13);
  await expect(editButton(page)).toBeVisible(); // groups from userinfo: an editor
  const menu = await openMore(page);
  await expect(menu).toContainText('Signed in as Anna');

  // The offline copy is saved while signed in, and forgotten on the way out.
  await expect
    .poll(() => page.evaluate(() => caches.has('housebook-data')), { timeout: 10_000 })
    .toBe(true);
  await menu.getByRole('link', { name: 'Log out' }).click();
  // Out at the provider too, then back home, which needs a login again.
  await expect(page.getByRole('heading', { name: 'Fake login' })).toBeVisible();
  expect(idp.logouts).toContain(`${url}/`);
  await page.goto(`${url}/manifest.webmanifest`); // the app's origin, without a login
  expect(await page.evaluate(() => caches.has('housebook-data'))).toBe(false);
  expect((await page.request.get(`${url}/api/me`)).status()).toBe(401);
});

test('someone outside the editor group can look but not edit', async ({ page, backend }) => {
  const { url } = await backend({}, oidcEnv());
  await page.goto(`${url}/`);
  await page.getByRole('link', { name: 'Sign in as Kid' }).click();
  await expect(planItems(page)).toHaveCount(13);
  await expect(await openMore(page)).toContainText('Signed in as Kid');
  await expect(editButton(page)).toHaveCount(0);
  const write = await page.request.post(`${url}/api/items/${DISHWASHER}/log`, {
    data: { text: 'not allowed' },
  });
  expect(write.status()).toBe(403);
});

test('with the provider down, the login says so instead of failing silently', async ({
  page,
  backend,
}) => {
  const { url } = await backend({}, { ...oidcEnv(), HOUSEBOOK_OIDC_ISSUER: 'http://127.0.0.1:9' });
  await page.goto(`${url}/`);
  await expect(page.getByRole('heading', { name: 'Can’t reach the login provider' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute(
    'href',
    '/api/auth/login?next=%2F',
  );
});
