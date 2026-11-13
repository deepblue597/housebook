import { describe, expect, it } from 'vitest';
import { type BuildFile, precacheList } from './precache';

const chunk = (fileName: string, ...moduleIds: string[]): BuildFile => ({
  fileName,
  type: 'chunk',
  moduleIds,
});
const asset = (fileName: string): BuildFile => ({ fileName, type: 'asset', moduleIds: [] });
const nm = '/repo/apps/web/node_modules';

describe('precacheList', () => {
  const list = precacheList([
    asset('index.html'),
    chunk('assets/index-AAAAAAAA.js', '/repo/apps/web/src/main.tsx', `${nm}/react/index.js`),
    chunk(
      'assets/MarkdownBody-BBBBBBBB.js',
      `${nm}/.pnpm/react-markdown@10/node_modules/react-markdown/x.js`,
    ),
    chunk(
      'assets/Scene3dView-CCCCCCCC.js',
      `${nm}/.pnpm/three@0.182.0/node_modules/three/build/three.module.js`,
    ),
    chunk(
      'assets/PdfViewer-DDDDDDDD.js',
      `${nm}/.pnpm/pdfjs-dist@6/node_modules/pdfjs-dist/build/pdf.mjs`,
    ),
    chunk('sw.js', '/repo/apps/web/src/sw/sw.ts'),
    asset('assets/index-EEEEEEEE.css'),
    asset('assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2'),
    asset('assets/ibm-plex-sans-latin-ext-400-normal-FFFFFFFF.woff2'),
    asset('assets/ibm-plex-sans-cyrillic-400-normal-GGGGGGGG.woff2'),
    asset('assets/ibm-plex-sans-latin-400-normal-HHHHHHHH.woff'),
    asset('assets/oven-BgfX4j1u.glb'),
    asset('assets/oak-IIIIIIII.jpg'),
    asset('assets/pdf.worker.min-CIqJB0yW.mjs'),
    asset('assets/index-AAAAAAAA.js.map'),
  ]);

  it('saves what the 2D app needs offline', () => {
    expect(list).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/assets/index-AAAAAAAA.js',
        '/assets/MarkdownBody-BBBBBBBB.js',
        '/assets/index-EEEEEEEE.css',
        '/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2',
        '/manifest.webmanifest',
        '/favicon.svg',
        '/icon-192.png',
      ]),
    );
  });

  it('leaves 3D, PDF.js, other font subsets, models, textures and source maps for later', () => {
    for (const f of [
      '/assets/Scene3dView-CCCCCCCC.js',
      '/assets/PdfViewer-DDDDDDDD.js',
      '/sw.js',
      '/assets/ibm-plex-sans-latin-ext-400-normal-FFFFFFFF.woff2',
      '/assets/ibm-plex-sans-cyrillic-400-normal-GGGGGGGG.woff2',
      '/assets/ibm-plex-sans-latin-400-normal-HHHHHHHH.woff',
      '/assets/oven-BgfX4j1u.glb',
      '/assets/oak-IIIIIIII.jpg',
      '/assets/pdf.worker.min-CIqJB0yW.mjs',
      '/assets/index-AAAAAAAA.js.map',
    ])
      expect(list).not.toContain(f);
  });

  it('is sorted and without duplicates', () => {
    expect(list).toEqual([...new Set(list)].sort());
  });
});
