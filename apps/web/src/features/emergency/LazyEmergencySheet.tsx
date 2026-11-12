import { Suspense, lazy } from 'react';

const EmergencySheet = lazy(() => import('./EmergencySheet'));

/** The printable emergency sheet (D44) in its own chunk: the app shell never loads it. */
export function LazyEmergencySheet() {
  return (
    <Suspense fallback={null}>
      <EmergencySheet />
    </Suspense>
  );
}
