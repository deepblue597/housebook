import { afterEach, describe, expect, it, vi } from 'vitest';

// The 3D chunk fails to load (offline, or a stale tab after a deploy: 404).
vi.mock('../features/scene3d/Scene3dView', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

describe('loading the 3D chunk (M2-05)', () => {
  afterEach(() => vi.resetModules());

  it('a failed import stays failed: the same rejected promise, no re-import per render', async () => {
    const { loadScene3d } = await import('./scene3d');
    const first = loadScene3d();
    await expect(first).rejects.toThrow();
    // What React's use() sees on every re-render: the same settled promise, so the error
    // boundary takes over instead of suspending on a fresh import forever.
    for (let i = 0; i < 5; i++) expect(loadScene3d()).toBe(first);
  });

  it('only an explicit choice of 3D tries again', async () => {
    const { choose3d, loadScene3d } = await import('./scene3d');
    const { useUi } = await import('../store/ui');
    const first = loadScene3d();
    await expect(first).rejects.toThrow();
    useUi.getState().setScene3dIssue('load_failed');
    choose3d();
    expect(useUi.getState()).toMatchObject({ planStyle: '3d', scene3dIssue: null });
    const second = loadScene3d();
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });
});
