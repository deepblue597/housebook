import { Suspense, lazy } from 'react';
import type { PrintPage } from './pages';

const PAGES = {
  emergency: lazy(() => import('../emergency/EmergencySheet')),
  stickers: lazy(() => import('../stickers/StickerSheet')),
};

/** A print page in its own chunk: the app shell never loads them. */
export function LazyPrintPage({ page }: { page: PrintPage }) {
  const Page = PAGES[page];
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}
