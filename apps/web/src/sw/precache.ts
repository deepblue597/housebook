/**
 * Which build files the service worker saves on install (D47). Used by vite-plugin-sw.ts at
 * build time; pure so it is unit-tested.
 *
 * Saved: index.html, every script and stylesheet the 2D app can need (lazy ones too: notes,
 * the editor, print pages), the latin subset of the fonts and the app's icons. Not saved up
 * front: the 3D view (three.js, models, textures) and PDF.js, ~1.5 MB that an emergency doesn't
 * need; they are saved the first time they are used, like the other font subsets.
 */

export interface BuildFile {
  fileName: string;
  type: 'chunk' | 'asset';
  /** Modules in a chunk (absolute paths); empty for assets. */
  moduleIds: readonly string[];
}

/** Files from `public/` that the app itself refers to. */
export const PUBLIC_FILES = [
  'favicon.svg',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
] as const;

const ON_DEMAND =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(three|pdfjs-dist|@react-three)[\\/]/;
// fontsource names files `<family>-<subset>-<weight>-<style>-<hash>.woff2`.
const LATIN_FONT = /-latin-\d+-(normal|italic)-[\w-]+\.woff2$/;

export function precacheList(files: readonly BuildFile[]): string[] {
  const keep = (f: BuildFile): boolean => {
    if (f.fileName === 'sw.js') return false;
    if (f.type === 'chunk')
      return f.fileName.endsWith('.js') && !f.moduleIds.some((m) => ON_DEMAND.test(m));
    return (
      f.fileName === 'index.html' || f.fileName.endsWith('.css') || LATIN_FONT.test(f.fileName)
    );
  };
  const urls = files.filter(keep).map((f) => `/${f.fileName}`);
  return [...new Set([...urls, ...PUBLIC_FILES.map((p) => `/${p}`)])].sort();
}
