/**
 * Loading the 3D view: a dynamic import the first time 3D is opened, so three.js never reaches
 * the initial bundle (DESIGN 15.10), and whether 3D shows at all.
 */
import type { ComponentType } from 'react';
import type { FloorModel } from '../store/model';
import { useUi } from '../store/ui';
import { webglAvailable } from './webgl';

type SceneModule = { default: ComponentType<{ floor: FloorModel }> };

let pending: Promise<SceneModule> | null = null;
let failed = false;

/**
 * The 3D module, imported once. A failed import (offline, a stale tab after a new deploy) stays
 * failed: `use()` then throws into the error boundary, which falls back to 2D. Handing `use()` a
 * fresh promise per render instead would re-request the chunk in a tight loop (M2-05). Only an
 * explicit choice of 3D (`choose3d`) tries the import again.
 */
export function loadScene3d(): Promise<SceneModule> {
  pending ??= import('../features/scene3d/Scene3dView').catch((e: unknown) => {
    failed = true;
    throw e;
  });
  return pending;
}

/** Show the 3D view (the toggle, "Try 3D again", "Reload 3D"), retrying a failed import. */
export function choose3d(): void {
  if (failed) {
    pending = null;
    failed = false;
  }
  useUi.getState().setPlanStyle('3d');
}

/** 3D shows when chosen, supported by the browser, and not stopped this session. */
export function useShows3d(): boolean {
  const style = useUi((s) => s.planStyle);
  const issue = useUi((s) => s.scene3dIssue);
  return style === '3d' && issue === null && webglAvailable();
}
