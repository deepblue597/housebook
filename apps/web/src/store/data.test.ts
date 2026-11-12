import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Item, ItemChangedEvent, ResyncEvent } from '../api/types';
import { makeItem, snapshot } from '../test/fixtures';
import { relocate, useData } from './data';

const reset = () =>
  useData.setState({
    state: 'loading',
    model: null,
    etag: null,
    itemsVersion: null,
    error: null,
    loadedAt: null,
    problemCount: 0,
    me: null,
  });

describe('snapshot loading', () => {
  afterEach(reset);

  it('sends If-None-Match and keeps the model on 304', async () => {
    reset();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot), { status: 200, headers: { ETag: '"v1"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);

    await useData.getState().load();
    const model = useData.getState().model;
    expect(model?.items.size).toBe(3);
    await useData.getState().load();
    expect(useData.getState().model).toBe(model);
    const headers = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"v1"');
    vi.unstubAllGlobals();
  });

  it('reports an error state when the first load fails, keeps data on later failures', async () => {
    reset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await useData.getState().load();
    expect(useData.getState().state).toBe('error');

    useData.setState({ state: 'ready', model: { items: new Map() } as never });
    await useData.getState().load();
    expect(useData.getState().state).toBe('ready');
    expect(useData.getState().error).toMatch(/503/);
    vi.unstubAllGlobals();
  });
});

// ---- live sync: resync diffing, the dedupe rule, own writes (data contract §9) -------------

describe('live sync', () => {
  const json = (body: unknown, etag?: string) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: etag ? { ETag: `"${etag}"`, 'Content-Type': 'application/json' } : {},
    });
  const urls = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.map(
      (c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`,
    );

  async function loaded() {
    reset();
    const f = vi.fn().mockResolvedValueOnce(json(snapshot, 'snap1'));
    vi.stubGlobal('fetch', f);
    await useData.getState().load();
    f.mockReset();
    return f;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    reset();
  });

  const resync = (over: Partial<ResyncEvent> = {}): ResyncEvent => ({
    houseEtag: snapshot.houseEtag,
    houseReadOnly: false,
    itemsVersion: snapshot.itemsVersion,
    texturesVersion: snapshot.texturesVersion,
    problemCount: 0,
    ...over,
  });
  const changed = (item: Item, over: Partial<ItemChangedEvent> = {}): ItemChangedEvent => ({
    id: item.id,
    etag: item.etag,
    path: item.path,
    stale: item.stale,
    attachmentsEtag: item.attachmentsEtag,
    ...over,
  });

  it('resync with the same itemsVersion and houseEtag fetches nothing', async () => {
    const f = await loaded();
    const model = useData.getState().model;
    await useData.getState().resync(resync({ problemCount: 4 }));
    expect(f).not.toHaveBeenCalled();
    expect(useData.getState().model).toBe(model);
    expect(useData.getState().problemCount).toBe(4);
  });

  it('resync with another itemsVersion refetches the snapshot with If-None-Match', async () => {
    const f = await loaded();
    f.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await useData.getState().resync(resync({ itemsVersion: 'other' }));
    expect(urls(f)).toEqual(['GET /api/snapshot']);
    expect(
      ((f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)['If-None-Match'],
    ).toBe('"snap1"');
  });

  it('resync with only another houseEtag fetches just the layout and relocates items', async () => {
    const f = await loaded();
    const house = structuredClone(snapshot.house!);
    house.placements = [{ itemId: 'it_fridge', floorId: 'fl_0', x: 2, y: 0, rotation: 90 }];
    f.mockResolvedValueOnce(json(house, 'h2'));
    await useData.getState().resync(resync({ houseEtag: 'h2' }));
    expect(urls(f)).toEqual(['GET /api/house']);
    const m = useData.getState().model!;
    expect(m.snapshot.houseEtag).toBe('h2');
    expect(m.items.get('it_fridge')!.location).toEqual({
      floorId: 'fl_0',
      roomId: 'rm_bat',
      x: 2,
      y: 0,
      rotation: 90,
    });
    expect(m.items.get('it_dish')!.location).toBeNull();
    // Items didn't change: itemsVersion is still known, so the next resync stays quiet.
    expect(useData.getState().itemsVersion).toBe(snapshot.itemsVersion);
  });

  it('house.changed with the held etag is ignored; null etag refetches the snapshot', async () => {
    const f = await loaded();
    await useData.getState().houseChanged({ etag: snapshot.houseEtag, readOnly: false });
    expect(f).not.toHaveBeenCalled();
    f.mockResolvedValueOnce(json({ ...snapshot, house: null, houseEtag: null }, 'snap2'));
    await useData.getState().houseChanged({ etag: null, readOnly: false });
    expect(urls(f)).toEqual(['GET /api/snapshot']);
    expect(useData.getState().model!.snapshot.house).toBeNull();
  });

  it('item.changed is ignored only when etag, path, stale and attachmentsEtag all match', async () => {
    const f = await loaded();
    const held = useData.getState().model!.items.get('it_dish')!;
    await useData.getState().itemChanged(changed(held, { etag: `"${held.etag}"` }));
    expect(f).not.toHaveBeenCalled();
    for (const over of [
      { etag: 'new' },
      { path: 'House/Kitchen/Renamed.md' },
      { stale: true },
      { attachmentsEtag: 'ffffffffffffffff' },
    ]) {
      f.mockResolvedValueOnce(json({ ...held, ...over, name: 'Dishwasher 2' }));
      await useData.getState().itemChanged(changed(held, over));
    }
    expect(urls(f)).toEqual(Array(4).fill('GET /api/items/it_dish'));
    expect(useData.getState().model!.items.get('it_dish')!.name).toBe('Dishwasher 2');
    // The held data is now newer than any snapshot ETag or itemsVersion we know.
    expect(useData.getState().etag).toBeNull();
    expect(useData.getState().itemsVersion).toBeNull();
  });

  it('after single-item updates a resync refetches the snapshot (version unknown)', async () => {
    const f = await loaded();
    const held = useData.getState().model!.items.get('it_dish')!;
    f.mockResolvedValueOnce(json({ ...held, etag: 'n' }));
    await useData.getState().itemChanged(changed(held, { etag: 'n' }));
    f.mockResolvedValueOnce(json(snapshot, 'snap3'));
    await useData.getState().resync(resync());
    expect(urls(f)).toEqual(['GET /api/items/it_dish', 'GET /api/snapshot']);
    expect(useData.getState().itemsVersion).toBe(snapshot.itemsVersion);
  });

  it('item.changed for a new item adds it; a 404 drops it; item.deleted drops it', async () => {
    const f = await loaded();
    const kettle = makeItem({ id: 'it_kettle', name: 'Kettle' });
    f.mockResolvedValueOnce(json(kettle));
    await useData.getState().itemChanged(changed(kettle));
    expect(useData.getState().model!.items.has('it_kettle')).toBe(true);
    f.mockResolvedValueOnce(new Response('{"detail":"gone"}', { status: 404 }));
    await useData.getState().itemChanged(changed(kettle, { etag: 'z' }));
    expect(useData.getState().model!.items.has('it_kettle')).toBe(false);
    await useData.getState().itemDeleted({ id: 'it_fridge' });
    expect(useData.getState().model!.items.has('it_fridge')).toBe(false);
  });

  it('a deleted item that is still placed becomes a ghost (missing note)', async () => {
    reset();
    const placed = {
      ...snapshot,
      house: {
        ...snapshot.house!,
        placements: [{ itemId: 'it_fridge', floorId: 'fl_0', x: 0, y: 0, rotation: 0 as const }],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(placed, 's')));
    await useData.getState().load();
    expect(useData.getState().model!.floors[0]!.ghosts).toEqual([]);
    await useData.getState().itemDeleted({ id: 'it_fridge' });
    expect(useData.getState().model!.floors[0]!.ghosts.map((g) => g.itemId)).toEqual(['it_fridge']);
  });

  it('the event announcing our own write arrives first: no refetch', async () => {
    const f = await loaded();
    const held = useData.getState().model!.items.get('it_dish')!;
    const written = { ...held, etag: 'w1', body: `${held.body}\n- 2026-11-06 Cleaned filter` };
    let respond!: (r: Response) => void;
    f.mockReturnValueOnce(new Promise<Response>((ok) => (respond = ok)));
    const write = useData.getState().appendLog('it_dish', 'Cleaned filter');
    // The server announces the write before its response reaches us.
    const event = useData.getState().itemChanged(changed(written));
    respond(json(written, 'w1'));
    await Promise.all([write, event]);
    expect(urls(f)).toEqual(['POST /api/items/it_dish/log']);
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string) as unknown;
    expect(body).toEqual({ text: 'Cleaned filter' });
    expect(useData.getState().model!.items.get('it_dish')!.body).toContain('Cleaned filter');
  });

  it('a failed write rejects with the server detail and changes nothing', async () => {
    const f = await loaded();
    const model = useData.getState().model;
    f.mockResolvedValueOnce(
      new Response('{"detail":"unparseable","reason":"unparseable"}', { status: 409 }),
    );
    await expect(useData.getState().appendLog('it_dish', 'x')).rejects.toMatchObject({
      status: 409,
      reason: 'unparseable',
    });
    expect(useData.getState().model).toBe(model);
  });

  it('a 401 on load is reported so the sync client can reload', async () => {
    reset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    expect(await useData.getState().load()).toBe('unauthorized');
  });

  it('problems.changed updates the count and bumps the revision', async () => {
    await loaded();
    const rev = useData.getState().problemsRev;
    useData.getState().problemsChanged({ count: 7 });
    expect(useData.getState().problemCount).toBe(7);
    expect(useData.getState().problemsRev).toBe(rev + 1);
  });

  it('textures.changed or a resync with another texturesVersion refetches the snapshot', async () => {
    const f = await loaded();
    await useData.getState().texturesChanged({ version: snapshot.texturesVersion });
    expect(f).not.toHaveBeenCalled();
    f.mockResolvedValueOnce(json({ ...snapshot, texturesVersion: 't2' }, 'snap2'));
    await useData.getState().texturesChanged({ version: 't2' });
    expect(urls(f)).toEqual(['GET /api/snapshot']);
    f.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await useData.getState().resync(resync({ texturesVersion: 't3' }));
    expect(urls(f)).toEqual(['GET /api/snapshot', 'GET /api/snapshot']);
  });

  it('adding a texture uploads the raw image, then holds the snapshot that lists it', async () => {
    const f = await loaded();
    const t = {
      key: 'my_abc123',
      label: 'Marble',
      kind: 'floor' as const,
      size: [0.6, 0.6] as [number, number],
      color: '#cccccc',
      url: '/api/textures/my_abc123?v=1',
    };
    f.mockResolvedValueOnce(json(t)).mockResolvedValueOnce(
      json({ ...snapshot, textures: [t], texturesVersion: 't2' }, 'snap2'),
    );
    const got = await useData
      .getState()
      .addTexture(new Blob(['x']), { kind: 'floor', label: 'Marble', width: 0.6, height: 0.6 });
    expect(got.key).toBe('my_abc123');
    expect(urls(f)).toEqual([
      'POST /api/textures?kind=floor&label=Marble&width=0.6&height=0.6',
      'GET /api/snapshot',
    ]);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
    expect(useData.getState().model?.snapshot.textures).toEqual([t]);
  });
});

describe('relocate', () => {
  it('derives location like the server: first placement, room of the anchor tile', () => {
    const house = {
      ...snapshot.house!,
      placements: [
        { itemId: 'it_dish', floorId: 'fl_0', x: 2, y: 0, rotation: 0 as const },
        { itemId: 'it_dish', floorId: 'fl_0', x: 0, y: 0, rotation: 0 as const },
        { itemId: 'it_heat', floorId: 'fl_x', x: 0, y: 0, rotation: 0 as const },
      ],
    };
    const [dish, fridge, heat] = relocate(snapshot.items, house);
    expect(dish!.location).toMatchObject({ x: 2, roomId: 'rm_bat' });
    expect(fridge!.location).toBeNull();
    expect(heat!.location).toMatchObject({ floorId: 'fl_x', roomId: null });
    const unplaced = { ...snapshot.items[0]!, location: null };
    expect(relocate([unplaced], { ...house, placements: [] })[0]).toBe(unplaced);
  });
});
