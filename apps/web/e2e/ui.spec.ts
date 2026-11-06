/**
 * Look and feel: theme toggle and dark mode, reduced motion, 360 px phones without horizontal
 * scroll, the status recompute after midnight, and a small visual-regression baseline.
 */
import type { Page } from '@playwright/test';
import {
  DISHWASHER,
  expect,
  expectNoA11yViolations,
  gotoPlan,
  item,
  panel,
  planItems,
  searchBox,
  test,
} from './support/fixtures';

const themeButton = (page: Page) => page.getByRole('button', { name: /^Theme: / });
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('theme toggle cycles auto → light → dark, applies and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await gotoPlan(page);
  await expect(themeButton(page)).toHaveAccessibleName('Theme: auto. Change theme');
  const light = await bg(page);

  await themeButton(page).click();
  await expect(themeButton(page)).toHaveAccessibleName('Theme: light. Change theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await themeButton(page).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await bg(page);
  expect(dark).not.toBe(light);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(themeButton(page)).toHaveAccessibleName('Theme: dark. Change theme');

  await themeButton(page).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await bg(page)).toBe(light);
  // "auto" follows the OS.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => bg(page)).toBe(dark);
});

test('dark mode: plan labels stay readable and axe passes on plan, panel and list', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await gotoPlan(page);
  await expect(planItems(page)).toHaveCount(13);
  await expectNoA11yViolations(page);
  await item(page, DISHWASHER).click();
  await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Items by floor and room' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('search state and room panel have no axe violations', async ({ page }) => {
  await gotoPlan(page);
  await searchBox(page).fill('fri'); // few results: the long list is FE-08
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await expectNoA11yViolations(page);
  await searchBox(page).press('Escape');
  await page.locator('.plan [data-room-id="rm_kit"]').click();
  await expect(panel(page).getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('FE-08: arrowing through a long result list keeps the active option in view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoPlan(page);
  await searchBox(page).fill('e');
  const options = page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
  await expect(options).toHaveCount(8);
  for (let i = 0; i < 7; i++) await searchBox(page).press('ArrowDown');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  const opt = (await options.last().boundingBox())!;
  const box = (await page.locator('.search .results').boundingBox())!;
  expect(opt.y + opt.height, 'active option below the visible list').toBeLessThanOrEqual(
    box.y + box.height,
  );
  await expectNoA11yViolations(page); // scrollable-region-focusable
});

test.describe('reduced motion @phone', () => {
  const motion = async (page: Page) => {
    await gotoPlan(page);
    await item(page, DISHWASHER).tap();
    await expect(panel(page)).toBeVisible();
    return {
      sheet: await panel(page).evaluate((el) => getComputedStyle(el).animationName),
      badge: await item(page, DISHWASHER)
        .locator('.bg')
        .evaluate((el) => getComputedStyle(el).transitionDuration),
    };
  };
  test('animations run normally', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await motion(page)).toEqual({ sheet: 'sheet-in', badge: '0.12s' });
  });
  test('prefers-reduced-motion turns them off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await motion(page)).toEqual({ sheet: 'none', badge: '0s' });
  });
});

test.describe('360 px phone', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  const noHorizontalScroll = async (page: Page, where: string) => {
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, `horizontal scroll: ${where}`).toBeLessThanOrEqual(client);
  };

  test('no horizontal page scroll anywhere; 44 px targets', async ({ page }) => {
    await gotoPlan(page);
    await expect(planItems(page)).toHaveCount(13);
    await noHorizontalScroll(page, 'plan');

    await searchBox(page).fill('a');
    await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
    await noHorizontalScroll(page, 'search results');
    await searchBox(page).fill('');

    await item(page, DISHWASHER).tap();
    await expect(panel(page).getByText('E15', { exact: true })).toBeVisible();
    await noHorizontalScroll(page, 'item sheet');
    // Bottom sheet: anchored to the bottom, at most 70 % of the screen.
    const box = (await panel(page).boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(739);
    expect(box.height).toBeLessThanOrEqual(740 * 0.7 + 1);
    expect(box.width).toBeCloseTo(360, 0);
    // Touch targets in the header and sheet.
    for (const el of [
      panel(page).getByRole('button', { name: 'Close details' }),
      page.getByRole('button', { name: 'List', exact: true }),
      themeButton(page),
      page.getByRole('button', { name: 'Zoom in' }),
    ]) {
      const b = (await el.boundingBox())!;
      expect(Math.min(b.width, b.height), (await el.textContent()) ?? '').toBeGreaterThanOrEqual(
        44,
      );
    }

    await panel(page).getByRole('button', { name: 'View manual.pdf' }).tap();
    await expect(
      page.getByRole('dialog', { name: 'manual.pdf' }).getByText('Page 1 of 1'),
    ).toBeVisible();
    await noHorizontalScroll(page, 'PDF dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).tap();
    await panel(page).getByRole('button', { name: 'Close details' }).tap();

    await page.getByRole('button', { name: 'List', exact: true }).tap();
    await expect(page.getByRole('region', { name: 'Items by floor and room' })).toBeVisible();
    await noHorizontalScroll(page, 'list');
    await expectNoA11yViolations(page);
  });
});

test('statuses are recomputed once the household day has passed the snapshot', async ({ page }) => {
  // Dishwasher: warranty_until 2027-05-10. Two weeks before, it is "ending" whatever the
  // server's today is, because the client recomputes for its own date.
  await page.clock.setFixedTime(new Date('2027-04-26T10:00:00+03:00'));
  await gotoPlan(page, `/i/${DISHWASHER}`);
  await expect(panel(page).getByText('Warranty ends in 14 days')).toBeVisible();
  await expect(item(page, DISHWASHER)).toHaveAttribute('aria-label', /Warranty ending/);
  await expect(item(page, DISHWASHER).locator('rect.mark.warn')).toHaveCount(1);
});

// ---- visual baseline ---------------------------------------------------------------------
// Few on purpose. A fixed clock makes the statuses deterministic (the client recomputes for
// its own date), fonts are bundled, animations are off. Update with
// `pnpm e2e -- --update-snapshots --grep @visual` and review the diff.

test.describe('visual @visual', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2027-01-15T10:00:00+02:00'));
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  });
  const ready = async (page: Page) => {
    await expect(planItems(page)).toHaveCount(13);
    await expect(page.locator('[data-sync="live"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  };

  test('plan', async ({ page }) => {
    await gotoPlan(page);
    await ready(page);
    await expect(page).toHaveScreenshot('plan.png');
  });

  test('selected item', async ({ page }) => {
    await gotoPlan(page, `/i/${DISHWASHER}`);
    await ready(page);
    await expect(panel(page).getByRole('heading', { level: 3, name: 'Quick help' })).toBeVisible();
    await expect(panel(page).locator('.attachments img')).toHaveJSProperty('complete', true);
    await page.locator(':focus').evaluate((el: HTMLElement) => el.blur());
    await expect(page).toHaveScreenshot('item-panel.png');
  });

  test('3D view', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('housebook.planStyle', '3d'));
    await page.goto(`/i/${DISHWASHER}`);
    await expect(page.locator('.scene3d')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('[data-sync="live"]')).toBeVisible();
    await expect(panel(page).getByRole('heading', { level: 3, name: 'Quick help' })).toBeVisible();
    await expect(panel(page).locator('.attachments img')).toHaveJSProperty('complete', true);
    await page.waitForFunction(() => {
      const s = (window as { __housebook?: { scene: { moving: () => boolean } | null } })
        .__housebook?.scene;
      return !!s && !s.moving();
    });
    await page.evaluate(() => document.fonts.ready);
    await page.locator(':focus').evaluate((el: HTMLElement) => el.blur());
    await expect(page).toHaveScreenshot('scene3d.png');
  });

  test('dark list', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoPlan(page);
    await ready(page);
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.getByRole('button', { name: 'List', exact: true }).blur();
    await expect(page).toHaveScreenshot('list-dark.png', { fullPage: true });
  });
});
