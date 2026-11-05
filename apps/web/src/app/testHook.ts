/**
 * Test hook for Playwright (DESIGN 15.15): `window.__housebook` exposes the stores and, while
 * the 3D view is open, a way to find items and tiles on screen, so e2e tests click exact
 * items instead of guessing pixels. Only in non-production builds: `pnpm e2e` builds with
 * `--mode e2e`; `pnpm build` (and the Docker image) drop this code entirely.
 */
import { useData } from '../store/data';
import { useUi } from '../store/ui';

export interface ScenePoint {
  /** Page coordinates (CSS px), ready for `page.mouse.click`. */
  x: number;
  y: number;
}

export interface SceneTestHook {
  /** Centre of the item's model on screen; null if the item isn't drawn. */
  itemToScreen: (id: string) => ScenePoint | null;
  /** Centre of a tile (on the floor plane) on screen. */
  cellToScreen: (x: number, y: number) => ScenePoint;
  /** The camera as applied to the last rendered frame. */
  camera: () => { x: number; z: number; zoom: number; angle: number; heading: string };
  /** True while the camera is still easing towards its goal. */
  moving: () => boolean;
  /** Frames rendered so far (frameloop="demand": stays flat while nothing changes). */
  frames: () => number;
  /** Ids of the item meshes in the scene, and the walls' triangle count. */
  info: () => { items: string[]; wallTriangles: number; floorId: string; wallHeight: number };
}

export interface TestHook {
  ui: typeof useUi;
  data: typeof useData;
  scene: SceneTestHook | null;
}

declare global {
  interface Window {
    __housebook?: TestHook;
  }
}

export function installTestHook(): void {
  if (import.meta.env.MODE === 'production') return;
  window.__housebook = { ui: useUi, data: useData, scene: null };
}
