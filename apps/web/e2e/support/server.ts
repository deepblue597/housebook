/**
 * Private Housebook backends for tests that need their own data (crafted notes, a broken
 * house.json, an empty root, files edited during the test). Each one gets a fresh temp data
 * root and a free port, serves the e2e build (`dist-e2e/`, with the test hook), and is stopped and deleted afterwards.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO = resolve(WEB, '../..');
export const EXAMPLE = join(REPO, 'examples/house');

export interface DataRootSpec {
  /** Start from a copy of examples/house (default) or from an empty folder. */
  fromExample?: boolean;
  /** house.json: an object is written as JSON, a string verbatim, null deletes the file. */
  house?: unknown;
  /** Extra or replaced files, relative to the data root. */
  files?: Record<string, string | Buffer>;
  /** Files to delete from the copy, relative to the data root. */
  remove?: string[];
}

export function makeDataRoot(spec: DataRootSpec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'housebook-e2e-crafted-'));
  if (spec.fromExample ?? true) {
    cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => basename(src) !== '.housebook' });
  }
  for (const rel of spec.remove ?? []) rmSync(join(dir, rel), { force: true, recursive: true });
  if (spec.house === null) rmSync(join(dir, 'house.json'), { force: true });
  else if (spec.house !== undefined) {
    writeFileSync(
      join(dir, 'house.json'),
      typeof spec.house === 'string' ? spec.house : JSON.stringify(spec.house, null, 2),
    );
  }
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() =>
        addr && typeof addr === 'object' ? ok(addr.port) : fail(new Error('no port')),
      );
    });
  });
}

export interface Backend {
  url: string;
  dataDir: string;
  stop: () => Promise<void>;
}

const BASE_ENV = {
  HOUSEBOOK_TZ: 'Europe/Athens',
  HOUSEBOOK_LOG_LEVEL: 'WARNING',
  HOUSEBOOK_HOST: '127.0.0.1',
};

/** Start `housebook serve` on `dataDir`; resolves once /readyz answers 200. */
export async function startBackend(dataDir: string, env: Record<string, string> = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const proc: ChildProcess = spawn(
    'uv',
    ['run', '--quiet', '--project', join(REPO, 'apps/api'), 'housebook', 'serve'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...BASE_ENV,
        HOUSEBOOK_DATA_DIR: dataDir,
        HOUSEBOOK_STATIC_DIR: join(WEB, 'dist-e2e'),
        HOUSEBOOK_PORT: String(port),
        ...env,
      },
    },
  );
  proc.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<void>((ok) => proc.once('exit', () => ok()));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`backend exited early:\n${output}`);
    try {
      if ((await fetch(`${url}/readyz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`backend not ready after 30 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100)); // poll interval for a readiness probe
  }

  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
  };
  return { url, stop };
}

/** A minimal valid PDF with one line of text per page (for paging tests). */
export function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    // Big text at a different height per page, so each page paints different pixels.
    const content = `BT /F1 72 Tf 72 ${650 - 120 * i} Td (${text}) Tj ET`;
    objs[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objs[5 + 2 * i] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A 1×1 PNG. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
