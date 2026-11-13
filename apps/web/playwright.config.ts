import { defineConfig, devices } from '@playwright/test';

// E2E runs against the real backend (apps/api) serving a temp copy of examples/house and the
// built SPA (`pnpm e2e` builds first; see e2e/serve.mjs). Tests that need crafted data start
// their own backend on a temp data root (e2e/support/fixtures.ts → `backend`).
//
// E2E_DOCKER=1 (`pnpm e2e:docker`) instead runs the @smoke tests against the Docker image
// (built from the repo root, or HOUSEBOOK_IMAGE), see e2e/serve-docker.mjs.
const docker = !!process.env.E2E_DOCKER;
const port = Number(process.env.E2E_PORT ?? (docker ? 8767 : 8766));
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retries only measure flakiness (a pass on retry is a flake to fix), never hide it.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // The service worker (D47) would answer requests that tests route or stub themselves; it
    // has its own tests (offline.spec.ts), which allow it.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 },
  },
  projects: docker
    ? [
        {
          name: 'docker',
          use: { ...devices['Desktop Chrome'] },
          grep: /@smoke/,
          grepInvert: /@phone/,
        },
      ]
    : [
        { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@phone/ },
        { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
      ],
  webServer: {
    command: docker ? 'node e2e/serve-docker.mjs' : 'node e2e/serve.mjs',
    url: `${baseURL}/readyz`,
    reuseExistingServer: !process.env.CI && !docker,
    timeout: docker ? 600_000 : 60_000, // the docker variant may build the image first
    env: { E2E_PORT: String(port) },
    // SIGTERM lets the serve scripts stop the backend and delete their temp data root.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
