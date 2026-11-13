import { describe, expect, it } from 'vitest';
import { snapshot } from '../test/fixtures';
import { fakeCaches } from '../test/fakeCaches';
import { type CacheStorageLike, clearOffline, readOffline, saveOffline } from './offlineCache';

describe('offline copy', () => {
  it('reads back what was saved, with the time it was current', async () => {
    const c = fakeCaches();
    const at = new Date('2026-11-13T10:00:00Z');
    await saveOffline(snapshot, at, c);
    const copy = await readOffline(c);
    expect(copy?.snapshot).toEqual(snapshot);
    expect(copy?.at).toEqual(at);
  });

  it('can update only the time (a 304: still current)', async () => {
    const c = fakeCaches();
    await saveOffline(snapshot, new Date('2026-11-13T10:00:00Z'), c);
    await saveOffline(null, new Date('2026-11-13T12:00:00Z'), c);
    const copy = await readOffline(c);
    expect(copy?.snapshot).toEqual(snapshot);
    expect(copy?.at.toISOString()).toBe('2026-11-13T12:00:00.000Z');
  });

  it('has nothing without a snapshot, without storage, or after clearing', async () => {
    const c = fakeCaches();
    await saveOffline(null, new Date(), c);
    expect(await readOffline(c)).toBeNull();
    expect(await readOffline(null)).toBeNull();
    await saveOffline(snapshot, new Date(), c);
    await clearOffline(c);
    expect(c.names()).toEqual([]);
    expect(await readOffline(c)).toBeNull();
  });

  it('fails quietly when storage does', async () => {
    const broken: CacheStorageLike = {
      open: () => Promise.reject(new Error('quota')),
      delete: () => Promise.reject(new Error('nope')),
    };
    await expect(saveOffline(snapshot, new Date(), broken)).resolves.toBeUndefined();
    await expect(readOffline(broken)).resolves.toBeNull();
    await expect(clearOffline(broken)).resolves.toBeUndefined();
  });
});
