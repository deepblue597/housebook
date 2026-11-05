/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

// The shared contract (catalog, golden fixtures) lives at the repo root.
const contractDir = fileURLToPath(new URL('../../contract', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const apiTarget = process.env.HOUSEBOOK_API ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [
    react(),
    // ANALYZE=1 pnpm build -> dist/stats.html (treemap of every chunk)
    process.env.ANALYZE ? visualizer({ filename: 'dist/stats.html', gzipSize: true }) : null,
  ],
  resolve: {
    alias: { '@contract': contractDir },
  },
  server: {
    fs: { allow: [repoRoot] },
    proxy: { '/api': apiTarget, '/healthz': apiTarget, '/readyz': apiTarget },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
