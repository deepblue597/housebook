/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import { serviceWorker } from './vite-plugin-sw.ts';

// The shared contract (catalog, golden fixtures) lives at the repo root.
const contractDir = fileURLToPath(new URL('../../contract', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const esm = (path: string) =>
  fileURLToPath(new URL(`./node_modules/@react-three/${path}`, import.meta.url));
const apiTarget = process.env.HOUSEBOOK_API ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [
    react(),
    // /sw.js: the app keeps working offline (D47).
    serviceWorker(),
    // ANALYZE=1 pnpm build -> dist/stats.html (treemap of every chunk)
    process.env.ANALYZE ? visualizer({ filename: 'dist/stats.html', gzipSize: true }) : null,
  ],
  resolve: {
    alias: { '@contract': contractDir },
  },
  // 3D models (src/assets/models) are assets: `?url` in the app, `?inline` in unit tests.
  assetsInclude: ['**/*.glb'],
  server: {
    fs: { allow: [repoRoot] },
    proxy: { '/api': apiTarget, '/healthz': apiTarget, '/readyz': apiTarget },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The 3D chunk (three + react-three-fiber + drei, ~250 KB gzipped) is lazy and only loads
    // when 3D is opened; the initial bundle is checked by `pnpm size`.
    chunkSizeWarningLimit: 1000,
    // 3D models are always separate, content-hashed files (served immutable, fetched only by
    // the 3D view), never inlined as data: URLs into the 3D chunk.
    assetsInlineLimit: (file) => (file.endsWith('.glb') ? false : undefined),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    // Use the ESM builds of the 3D packages: drei and the test renderer have no `exports` map,
    // so Node would load their CJS builds, which require() three's deprecated CJS build.
    server: { deps: { inline: [/@react-three\//, 'three-stdlib'] } },
    alias: {
      '@react-three/test-renderer': esm('test-renderer/dist/react-three-test-renderer.esm.js'),
      '@react-three/fiber': esm('fiber/dist/react-three-fiber.esm.js'),
    },
  },
});
