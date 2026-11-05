#!/usr/bin/env node
// Start the real backend for Playwright: a private copy of examples/house (so the process lock
// never clashes with a dev server on the same folder), serving the freshly built dist-e2e/
// (`vite build --mode e2e`: a production build plus the window.__housebook test hook).
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '../..');
const data = mkdtempSync(join(tmpdir(), 'housebook-e2e-'));
cpSync(join(repo, 'examples/house'), data, {
  recursive: true,
  filter: (src) => basename(src) !== '.housebook',
});

const server = spawn(
  'uv',
  ['run', '--quiet', '--project', join(repo, 'apps/api'), 'housebook', 'serve'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOUSEBOOK_DATA_DIR: data,
      HOUSEBOOK_STATIC_DIR: join(web, 'dist-e2e'),
      HOUSEBOOK_PORT: process.env.E2E_PORT ?? '8766',
      HOUSEBOOK_HOST: '127.0.0.1',
      HOUSEBOOK_TZ: 'Europe/Athens',
      HOUSEBOOK_OBSIDIAN_VAULT: 'homepage',
      HOUSEBOOK_OBSIDIAN_VAULT_SUBPATH: 'Housebook',
      HOUSEBOOK_LOG_LEVEL: 'WARNING',
    },
  },
);

const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  rmSync(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
