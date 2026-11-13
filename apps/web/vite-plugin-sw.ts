/**
 * Builds the service worker (src/sw/sw.ts, D47) to /sw.js and fills in this build's version and
 * the files to save on install (src/sw/precache.ts). Build only: `pnpm dev` has no service
 * worker, so nothing cached ever hides a code change during development.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { PUBLIC_FILES, precacheList } from './src/sw/precache.ts';

const ENTRY = fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url));
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const PLACEHOLDER = '__HOUSEBOOK_SW__';

export function serviceWorker(): Plugin {
  return {
    name: 'housebook-sw',
    apply: 'build',
    enforce: 'post',
    buildStart() {
      this.emitFile({ type: 'chunk', id: ENTRY, fileName: 'sw.js' });
    },
    generateBundle(_options, bundle) {
      const sw = bundle['sw.js'];
      if (sw?.type !== 'chunk') throw new Error('sw.js was not built');
      if (sw.imports.length || sw.dynamicImports.length)
        throw new Error(`sw.js must be self-contained, but imports ${sw.imports.join(', ')}`);
      const precache = precacheList(
        Object.values(bundle).map((f) => ({
          fileName: f.fileName,
          type: f.type,
          moduleIds: f.type === 'chunk' ? f.moduleIds : [],
        })),
      );
      // Hashed names change with their content; index.html and public files are hashed here.
      const hash = createHash('sha256');
      for (const url of precache) hash.update(url);
      const html = bundle['index.html'];
      if (html?.type === 'asset') hash.update(html.source);
      for (const f of PUBLIC_FILES) hash.update(readFileSync(PUBLIC + f));
      const version = hash.digest('hex').slice(0, 12);
      if (!sw.code.includes(PLACEHOLDER)) throw new Error(`${PLACEHOLDER} missing from sw.js`);
      sw.code = sw.code.replaceAll(PLACEHOLDER, JSON.stringify({ version, precache }));
    },
  };
}
