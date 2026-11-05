#!/usr/bin/env node
// Opt-in Docker smoke target (E2E_DOCKER=1): builds the image from the repo root (unless
// HOUSEBOOK_IMAGE names one), runs it hardened like compose.yaml on a temp copy of
// examples/house, and removes the container and the copy on SIGTERM/SIGINT.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '../..');
const port = process.env.E2E_PORT ?? '8767';
const name = `housebook-e2e-${process.pid}`;
const { uid, gid } = userInfo();

let image = process.env.HOUSEBOOK_IMAGE;
if (!image) {
  image = 'housebook:e2e';
  execFileSync(
    'docker',
    ['build', '--build-arg', `UID=${uid}`, '--build-arg', `GID=${gid}`, '-t', image, repo],
    { stdio: 'inherit' },
  );
}

const data = mkdtempSync(join(tmpdir(), 'housebook-e2e-docker-'));
cpSync(join(repo, 'examples/house'), data, {
  recursive: true,
  filter: (src) => basename(src) !== '.housebook',
});

const container = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--name',
    name,
    '--user',
    `${uid}:${gid}`,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '-e',
    'HOUSEBOOK_TZ=Europe/Athens',
    '-e',
    'HOUSEBOOK_OBSIDIAN_VAULT=homepage',
    '-e',
    'HOUSEBOOK_OBSIDIAN_VAULT_SUBPATH=Housebook',
    '-v',
    `${data}:/data`,
    '-p',
    `127.0.0.1:${port}:8000`,
    image,
  ],
  { stdio: 'inherit' },
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  } catch {
    // already gone
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
container.on('exit', (code) => {
  rmSync(data, { recursive: true, force: true });
  process.exit(stopping ? 0 : (code ?? 0));
});
