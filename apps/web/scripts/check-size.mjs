#!/usr/bin/env node
// Bundle budget (DESIGN 15.10): the JavaScript a first visit downloads (the entry script plus
// everything index.html preloads) must stay at or under 200 KB gzipped. Lazy chunks (Markdown,
// PDF.js) are listed but don't count. Run after `pnpm build`.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = Number(process.env.BUDGET_KB ?? 200);
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

let html;
try {
  html = readFileSync(join(dist, 'index.html'), 'utf8');
} catch {
  console.error('dist/index.html not found; run `pnpm build` first.');
  process.exit(2);
}

const initial = new Set(
  [
    ...html.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\/?([^"]+\.js)"/g),
  ].map((m) => m[1]),
);
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length / 1024;
const kb = (n) => `${n.toFixed(1).padStart(7)} KB`;

const chunks = readdirSync(join(dist, 'assets'))
  .filter((f) => /\.m?js$/.test(f))
  .map((f) => ({ file: `assets/${f}`, size: gz(`assets/${f}`) }))
  .sort((a, b) => b.size - a.size);

let total = 0;
console.log('gzipped JS chunks:');
for (const c of chunks) {
  const isInitial = initial.has(c.file);
  if (isInitial) total += c.size;
  console.log(`  ${kb(c.size)}  ${isInitial ? 'initial' : 'lazy   '}  ${c.file}`);
}
console.log(`\ninitial JS: ${kb(total).trim()} gzipped (budget ${BUDGET_KB} KB)`);
if (total > BUDGET_KB) {
  console.error('Over budget. Lazy-load the offender (React.lazy / dynamic import).');
  process.exit(1);
}
