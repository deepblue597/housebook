import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as client from '../api/client';
import { ApiError, fetchHouse, postItem, putHouse } from '../api/client';
import type { House, Snapshot } from '../api/types';
import { layoutIssues } from '../domain/layout';
import { makeItem, seedStore, snapshot } from '../test/fixtures';
import { useData } from './data';
import { SAVE_DELAY_MS, resetEditorForTests, useEditor } from './editor';
import { useUi } from './ui';

vi.mock('../api/client', async (importOriginal) => {
  const real = await importOriginal<ClientModule>();
  return { ...real, putHouse: vi.fn(), fetchHouse: vi.fn(), postItem: vi.fn() };
});
type ClientModule = typeof client;
const put = vi.mocked(putHouse);
const getHouse = vi.mocked(fetchHouse);
const post = vi.mocked(postItem);

const server = (): House => ({
  ...structuredClone(snapshot.house!),
  placements: [{ itemId: 'it_fridge', floorId: 'fl_0', x: 0, y: 0, rotation: 0 }],
});
const snap = (): Snapshot => ({ ...snapshot, house: server(), houseEtag: 'h1' });

const ed = () => useEditor.getState();
const shown = () => useData.getState().model!.snapshot.house!;
const cells = (h: House) => h.floors[0]!.cells!;

/** Let queued promises (the data queue, mocked requests) run. */
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
/** Past the save debounce, and the save itself. */
const afterDebounce = async () => {
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
  await flush();
};
/** What PUT /api/house answers: the body as written and a new ETag. */
const accept = (etag: string) => (h: House) => Promise.resolve({ house: structuredClone(h), etag });

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorForTests();
  put.mockReset();
  getHouse.mockReset();
  post.mockReset();
  seedStore(snap());
  useData.setState({
    me: { user: null, role: 'editor', authMode: 'none', name: null, logoutUrl: null },
  });
  ed().setMode('edit');
});
afterEach(() => {
  resetEditorForTests();
  vi.useRealTimers();
});

describe('edits and saving', () => {
  it('shows an edit at once and saves it ~1 s after the last edit, once, with If-Match', async () => {
    put.mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 1, y: 1 }, false);
    expect(cells(shown())).toMatchObject({ '0,1': 'rm_kit', '1,1': 'rm_kit' });
    expect(ed().save).toBe('pending');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 100);
    ed().paintRect('fl_0', { x: 3, y: 1 }, { x: 3, y: 1 }, false);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 100);
    expect(put).not.toHaveBeenCalled();
    await afterDebounce();
    expect(put).toHaveBeenCalledTimes(1);
    const [body, ifMatch] = put.mock.calls[0]!;
    expect(ifMatch).toBe('h1');
    expect(cells(body)).toMatchObject({ '0,1': 'rm_kit', '3,1': 'rm_kit' });
    expect(ed().save).toBe('saved');
    expect(ed().pending).toEqual([]);
    expect(useData.getState().model!.snapshot.houseEtag).toBe('h2');
  });

  it('labels edits and undoes/redoes them; undo of a saved edit is saved too', async () => {
    put.mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 2, y: 1 }, false);
    expect(ed().undo.map((e) => e.label)).toEqual(['paint 3 tiles Kitchen']);
    await afterDebounce();
    put.mockImplementation(accept('h3'));
    ed().undoLast();
    expect(cells(shown())['0,1']).toBeUndefined();
    expect(ed().redo).toHaveLength(1);
    await afterDebounce();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![1]).toBe('h2');
    expect(cells(put.mock.calls[1]![0])['0,1']).toBeUndefined();
    ed().redoLast();
    expect(cells(shown())['2,1']).toBe('rm_kit');
  });

  it('moves, rotates and removes items; the item list follows the layout', () => {
    ed().moveItem('it_fridge', 2, 1);
    expect(useData.getState().model!.items.get('it_fridge')!.location).toMatchObject({
      x: 2,
      y: 1,
      roomId: null,
    });
    ed().rotateItem('it_fridge');
    expect(shown().placements![0]).toMatchObject({ x: 2, y: 1, rotation: 90 });
    ed().unplaceItem('it_fridge');
    expect(useData.getState().model!.unplaced.map((i) => i.id)).toContain('it_fridge');
    ed().undoLast();
    ed().undoLast();
    ed().undoLast();
    expect(shown().placements).toEqual(server().placements);
  });

  it('room create, rename, recolour (consecutive recolours are one step)', () => {
    const id = ed().addRoom()!;
    expect(shown().rooms!.find((r) => r.id === id)).toMatchObject({ name: 'Room 3' });
    expect(ed().tool).toBe('paint');
    expect(ed().paintRoomId).toBe(id);
    expect(ed().renameRoom(id, '  Garage ')).toBe(true);
    expect(ed().renameRoom(id, '   ')).toBe(false);
    ed().recolorRoom(id, '#000001');
    ed().recolorRoom(id, '#000002');
    ed().recolorRoom(id, '#000003');
    expect(ed().undo.map((e) => e.label)).toEqual([
      'add room Room 3',
      'rename Room 3 to Garage',
      'recolour Garage',
    ]);
    ed().undoLast();
    expect(shown().rooms!.find((r) => r.id === id)!.color).not.toBe('#000003');
    expect(shown().rooms!.find((r) => r.id === id)!.name).toBe('Garage');
  });

  it('refuses edits for viewers and explains impossible ones', () => {
    ed().paintRect('fl_0', { x: 9, y: 9 }, { x: 9, y: 9 }, false);
    expect(ed().notices.at(-1)!.text).toMatch(/outside the house/);
    useData.setState({
      me: { user: null, role: 'viewer', authMode: 'none', name: null, logoutUrl: null },
    });
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    expect(ed().pending).toEqual([]);
  });

  it('creates the note first, then places it (D8)', async () => {
    const created = makeItem({ id: 'it_new', name: 'Mesh', type: 'router' });
    const order: string[] = [];
    post.mockImplementation((body) => {
      order.push(`POST ${JSON.stringify(body)}`);
      return Promise.resolve(created);
    });
    put.mockImplementation((h) => {
      order.push('PUT');
      return accept('h2')(h);
    });
    await ed().createAndPlace({ type: 'router', floorId: 'fl_0', cell: { x: 2, y: 0 } }, 'Mesh');
    expect(useUi.getState().selection).toEqual({ kind: 'item', id: 'it_new' });
    expect(shown().placements!.at(-1)).toEqual({
      itemId: 'it_new',
      floorId: 'fl_0',
      x: 2,
      y: 0,
      rotation: 0,
    });
    await afterDebounce();
    expect(order).toEqual(['POST {"type":"router","name":"Mesh","roomId":"rm_bat"}', 'PUT']);
    // Undo removes only the placement; the note stays and is unplaced.
    ed().undoLast();
    expect(useData.getState().model!.unplaced.map((i) => i.id)).toContain('it_new');
  });
});

describe('412: replay pending edits on the fresh layout', () => {
  it('re-applies and retries with the new ETag; both changes survive', async () => {
    const theirs = server();
    theirs.rooms![1]!.name = 'Bath';
    put
      .mockRejectedValueOnce(new ApiError(412, 'precondition failed'))
      .mockImplementation(accept('h3'));
    getHouse.mockResolvedValue({ house: theirs, etag: 'h2', readOnly: false });
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    await afterDebounce();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![1]).toBe('h2');
    const body = put.mock.calls[1]![0];
    expect(cells(body)['0,1']).toBe('rm_kit');
    expect(body.rooms![1]!.name).toBe('Bath');
    expect(ed().save).toBe('saved');
    expect(ed().notices).toEqual([]);
    expect(shown().rooms![1]!.name).toBe('Bath');
  });

  it('drops an edit that no longer applies, says so, and removes it from the history', async () => {
    const theirs = server();
    theirs.rooms = theirs.rooms!.filter((r) => r.id !== 'rm_bat');
    delete theirs.floors[0]!.cells!['2,0'];
    put
      .mockRejectedValueOnce(new ApiError(412, 'precondition failed'))
      .mockImplementation(accept('h3'));
    getHouse.mockResolvedValue({ house: theirs, etag: 'h2', readOnly: false });
    ed().setPaintRoom('rm_bat');
    ed().paintRect('fl_0', { x: 3, y: 1 }, { x: 3, y: 1 }, false);
    ed().paintRect('fl_0', { x: 3, y: 0 }, { x: 3, y: 0 }, true);
    ed().moveItem('it_fridge', 1, 0);
    await afterDebounce();
    expect(ed().notices.map((n) => n.text)).toEqual([
      'Your edit “paint 1 tile Bathroom” was dropped: the room “Bathroom” no longer exists.',
    ]);
    expect(ed().undo.map((e) => e.label)).toEqual(['move Fridge']);
    const saved = put.mock.calls.at(-1)![0];
    expect(saved.placements![0]).toMatchObject({ x: 1, y: 0 });
    expect(cells(saved)['3,1']).toBeUndefined();
  });
});

describe('a layout arriving while edits are pending', () => {
  it('house.changed: the new layout is the base, pending edits are replayed on it', async () => {
    const theirs = server();
    theirs.rooms![0]!.color = '#000000';
    getHouse.mockResolvedValue({ house: theirs, etag: 'h2', readOnly: false });
    put.mockImplementation(accept('h3'));
    ed().paintRect('fl_0', { x: 1, y: 1 }, { x: 1, y: 1 }, false);
    await useData.getState().houseChanged({ etag: 'h2', readOnly: false });
    expect(shown().rooms![0]!.color).toBe('#000000');
    expect(cells(shown())['1,1']).toBe('rm_kit');
    expect(ed().pending).toHaveLength(1);
    await afterDebounce();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![1]).toBe('h2');
  });

  it('the event for our own save is ignored', async () => {
    put.mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 1, y: 1 }, { x: 1, y: 1 }, false);
    await afterDebounce();
    await useData.getState().houseChanged({ etag: 'h2', readOnly: false });
    expect(getHouse).not.toHaveBeenCalled();
  });

  it('edits made while a save is in flight stay pending and are saved next', async () => {
    let release!: () => void;
    put.mockImplementationOnce(
      (h) => new Promise((ok) => (release = () => ok({ house: structuredClone(h), etag: 'h2' }))),
    );
    put.mockImplementation(accept('h3'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    await afterDebounce();
    expect(ed().save).toBe('saving');
    ed().paintRect('fl_0', { x: 1, y: 1 }, { x: 1, y: 1 }, false);
    release();
    await flush();
    expect(ed().pending).toHaveLength(1);
    expect(cells(shown())).toMatchObject({ '0,1': 'rm_kit', '1,1': 'rm_kit' });
    await afterDebounce();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![1]).toBe('h2');
    expect(ed().save).toBe('saved');
  });

  it('a layout that became read-only drops the unsaved edits with an error', async () => {
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...snap(), houseReadOnly: true, houseEtag: 'h9' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await useData.getState().houseChanged({ etag: 'h9', readOnly: true });
    vi.unstubAllGlobals();
    expect(ed().mode).toBe('view');
    expect(ed().pending).toEqual([]);
    expect(ed().notices.at(-1)).toMatchObject({ tone: 'error' });
  });
});

describe('save failures', () => {
  it('a rejected layout (422) is an error without retries; discard goes back to the server', async () => {
    put.mockRejectedValue(new ApiError(422, 'x', 'cell 9,9 is outside the grid'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    await afterDebounce();
    expect(ed().save).toBe('error');
    expect(ed().saveFatal).toBe(true);
    expect(ed().saveError).toMatch(/refused the layout: cell 9,9 is outside the grid.*report/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
    ed().discard();
    expect(shown()).toEqual(server());
    expect(ed().undo).toEqual([]);
  });

  it('a network error is retried by itself', async () => {
    put.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    await afterDebounce();
    expect(ed().save).toBe('error');
    expect(ed().saveFatal).toBe(false);
    await vi.advanceTimersByTimeAsync(2_100);
    await flush();
    expect(put).toHaveBeenCalledTimes(2);
    expect(ed().save).toBe('saved');
  });

  it('leaving edit mode saves at once', async () => {
    put.mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    ed().setMode('view');
    await flush();
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('ghosts', () => {
  it('relinks a placement without a note to an unplaced item, as one undo step', () => {
    const h = server();
    h.placements!.push({ itemId: 'it_gone', floorId: 'fl_0', x: 3, y: 1, rotation: 90 });
    seedStore({ ...snap(), house: h });
    useData.setState({
      me: { user: null, role: 'editor', authMode: 'none', name: null, logoutUrl: null },
    });
    ed().relinkGhost('it_gone', 'it_heat');
    expect(shown().placements!.map((p) => p.itemId)).toEqual(['it_fridge', 'it_heat']);
    expect(shown().placements![1]).toMatchObject({ x: 3, y: 1, rotation: 90 });
    expect(useUi.getState().selection).toEqual({ kind: 'item', id: 'it_heat' });
    ed().undoLast();
    expect(shown().placements!.map((p) => p.itemId)).toEqual(['it_fridge', 'it_gone']);
    ed().removeGhost('it_gone');
    expect(shown().placements!.map((p) => p.itemId)).toEqual(['it_fridge']);
  });
});

describe('a save whose response was lost (M5-01)', () => {
  it('the retry finds it on the server: no replay, and undo still undoes it', async () => {
    let written: House | null = null;
    put.mockImplementationOnce((h) => {
      written = structuredClone(h);
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    put.mockImplementationOnce(() => Promise.reject(new ApiError(412, 'precondition failed')));
    getHouse.mockImplementation(() =>
      Promise.resolve({ house: written!, etag: 'h2', readOnly: false }),
    );
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    await afterDebounce();
    expect(ed().save).toBe('error');
    await vi.advanceTimersByTimeAsync(2_100);
    await flush();
    expect(ed().save).toBe('saved');
    expect(ed().pending).toEqual([]);
    put.mockImplementation(accept('h3'));
    ed().undoLast();
    expect(cells(shown())['0,1']).toBeUndefined();
    await afterDebounce();
    expect(put.mock.calls.at(-1)![1]).toBe('h2');
    expect(cells(put.mock.calls.at(-1)![0])['0,1']).toBeUndefined();
  });

  it('an edit already there after replay keeps its original undo', async () => {
    // The same paint arrives from elsewhere (SSE) while ours is pending: a no-op on replay.
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    const theirs = server();
    theirs.floors[0]!.cells!['0,1'] = 'rm_kit';
    getHouse.mockResolvedValue({ house: theirs, etag: 'h2', readOnly: false });
    await useData.getState().houseChanged({ etag: 'h2', readOnly: false });
    ed().undoLast();
    expect(cells(shown())['0,1']).toBeUndefined();
  });
});

describe('another writer resized the house (M5-02)', () => {
  /** The layout grown by `n` tiles on the west side, as another writer would save it. */
  const grownWest = (h: House, n: number): House => ({
    ...h,
    grid: { ...h.grid, width: h.grid.width + n },
    floors: h.floors.map((f) => ({
      ...f,
      cells: Object.fromEntries(
        Object.entries(f.cells ?? {}).map(([k, v]) => {
          const [x, y] = k.split(',').map(Number);
          return [`${x! + n},${y!}`, v];
        }),
      ),
    })),
    placements: (h.placements ?? []).map((p) => ({ ...p, x: p.x + n })),
  });

  it('a pending paint and move are translated to the shifted tiles', async () => {
    put.mockRejectedValueOnce(new ApiError(412, 'pf')).mockImplementation(accept('h3'));
    getHouse.mockResolvedValue({ house: grownWest(server(), 2), etag: 'h2', readOnly: false });
    ed().paintRect('fl_0', { x: 3, y: 1 }, { x: 3, y: 1 }, false);
    ed().moveItem('it_fridge', 1, 1);
    await afterDebounce();
    const saved = put.mock.calls.at(-1)![0];
    expect(cells(saved)['5,1']).toBe('rm_kit');
    expect(cells(saved)['3,1']).toBeUndefined();
    expect(saved.placements![0]).toMatchObject({ x: 3, y: 1 });
    expect(ed().notices).toEqual([]);
    // Undo goes to the right tiles too.
    ed().undoLast();
    ed().undoLast();
    expect(cells(shown())['5,1']).toBeUndefined();
    expect(shown().placements![0]).toMatchObject({ x: 2, y: 0 });
  });

  it('with nothing pending, the history follows the shift', async () => {
    put.mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 3, y: 1 }, { x: 3, y: 1 }, false);
    await afterDebounce();
    const theirs = grownWest(structuredClone(put.mock.calls[0]![0]), 2);
    getHouse.mockResolvedValue({ house: theirs, etag: 'h9', readOnly: false });
    await useData.getState().houseChanged({ etag: 'h9', readOnly: false });
    expect(shown().grid.width).toBe(6);
    ed().undoLast();
    expect(cells(shown())['5,1']).toBeUndefined();
    expect(cells(shown())['2,0']).toBe('rm_kit');
  });

  it('when the shift can’t be told, pending edits and the history are dropped with messages', async () => {
    put.mockRejectedValueOnce(new ApiError(412, 'pf')).mockImplementation(accept('h3'));
    const theirs = grownWest(server(), 2);
    theirs.floors[0]!.cells!['0,1'] = 'rm_bat'; // resized and painted
    getHouse.mockResolvedValue({ house: theirs, etag: 'h2', readOnly: false });
    ed().paintRect('fl_0', { x: 3, y: 1 }, { x: 3, y: 1 }, false);
    await afterDebounce();
    expect(ed().notices.map((n) => n.text)).toEqual([
      'Your edit “paint 1 tile Kitchen” was dropped: the house was resized elsewhere.',
      'The house was resized elsewhere, so the undo history no longer fits it and was cleared.',
    ]);
    expect(ed().undo).toEqual([]);
    expect(ed().pending).toEqual([]);
    expect(shown()).toEqual(theirs);
  });
});

describe('repairs (D30)', () => {
  const brokenStore = () => {
    const h = server();
    h.floors[0]!.cells!['3,1'] = 'rm_gone';
    seedStore({ ...snap(), house: h });
    useData.setState({
      me: { user: null, role: 'editor', authMode: 'none', name: null, logoutUrl: null },
    });
  };
  const issue = () => layoutIssues(shown(), () => [1, 1])[0]!;

  it('runs as one edit and is autosaved; undo works until it is saved', async () => {
    brokenStore();
    put.mockImplementation(accept('h2'));
    expect(ed().repair(issue(), 'recreate_room')).toBe(true);
    expect(shown().rooms!.find((r) => r.id === 'rm_gone')).toMatchObject({
      name: 'Recovered room',
    });
    expect(ed().undo.at(-1)!.label).toBe('recreate room rm_gone');
    ed().undoLast();
    expect(shown().rooms!.map((r) => r.id)).not.toContain('rm_gone');
    ed().redoLast();
    await afterDebounce();
    expect(put.mock.calls.at(-1)![0].rooms!.map((r) => r.id)).toContain('rm_gone');
  });

  it('once saved, undoing it is refused with a reason (the server would refuse it)', async () => {
    brokenStore();
    put.mockImplementation(accept('h2'));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    ed().repair(issue(), 'erase_tiles');
    await afterDebounce();
    ed().undoLast();
    expect(cells(shown())['3,1']).toBeUndefined();
    expect(ed().notices.at(-1)!.text).toMatch(/already saved, so it can’t be undone/);
    // The next undo goes on with the entry below.
    ed().undoLast();
    expect(cells(shown())['0,1']).toBeUndefined();
  });
});

describe('house.json turning unusable while an edit is pending (M5-10)', () => {
  it('a 412 whose layout is read-only drops the edit at once, without retrying', async () => {
    put.mockRejectedValue(new ApiError(412, 'pf'));
    getHouse.mockResolvedValue({ house: server(), etag: 'h2', readOnly: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 0, y: 1 }, false);
    await afterDebounce();
    vi.unstubAllGlobals();
    expect(put).toHaveBeenCalledTimes(1);
    expect(ed().mode).toBe('view');
    expect(ed().pending).toEqual([]);
    expect(ed().notices.at(-1)).toMatchObject({ tone: 'error' });
    expect(ed().notices.at(-1)!.text).toMatch(/read-only/);
    expect(ed().save).not.toBe('error');
  });
});

describe('rooms shared by floors (#14)', () => {
  const notices = () => ed().notices.map((n) => n.text);

  it('painting a new floor with a room from another floor says so, once', () => {
    const upstairs = ed().addFloor('above')!;
    ed().setPaintRoom('rm_kit');
    ed().paintRect(upstairs, { x: 0, y: 0 }, { x: 1, y: 0 }, false);
    expect(notices().at(-1)).toMatch(
      /^Kitchen is also on Ground: these tiles are part of the same room/,
    );
    const count = notices().length;
    // More tiles of it on the same floor: no second notice.
    ed().paintRect(upstairs, { x: 2, y: 0 }, { x: 2, y: 0 }, false);
    expect(notices()).toHaveLength(count);
  });

  it('renaming or recolouring a room on two floors says it changes on both; on one floor, nothing', () => {
    expect(ed().renameRoom('rm_bat', 'Bath')).toBe(true);
    expect(notices().some((t) => t.startsWith('Renamed'))).toBe(false);

    const upstairs = ed().addFloor('above')!;
    ed().setPaintRoom('rm_kit');
    ed().paintRect(upstairs, { x: 0, y: 0 }, { x: 0, y: 0 }, false);
    expect(ed().renameRoom('rm_kit', 'Terrace')).toBe(true);
    expect(notices().at(-1)).toMatch(/^Renamed to Terrace on .* and Ground: a room is the same/);
    ed().recolorRoom('rm_kit', '#123456');
    expect(notices().at(-1)).toMatch(/^Terrace changed colour on .* and Ground/);
  });
});

describe('open walls (D51)', () => {
  const openings = () => shown().openings ?? [];
  const wallAt = (y: number) => ({ x: 2, y, side: 'w' as const });
  beforeEach(() => {
    // Two rows: kitchen kitchen | bathroom, so the wall between them runs along x = 2.
    ed().paintRect('fl_0', { x: 0, y: 1 }, { x: 1, y: 1 }, false);
    ed().setPaintRoom('rm_bat');
    ed().paintRect('fl_0', { x: 2, y: 1 }, { x: 2, y: 1 }, false);
  });

  it('opens a run between two rooms as one step, and undo closes it again', () => {
    expect(ed().toggleOpenRun('fl_0', [wallAt(0), wallAt(1)])).toBe(true);
    expect(openings()).toEqual([
      { floorId: 'fl_0', x: 2, y: 0, side: 'w', kind: 'open' },
      { floorId: 'fl_0', x: 2, y: 1, side: 'w', kind: 'open' },
    ]);
    expect(ed().undo.at(-1)!.label).toBe('open 2 tiles of wall');
    ed().undoLast();
    expect(openings()).toEqual([]);
  });

  it('skips edges that are not between two rooms, and refuses a run with none', () => {
    // (2,0,n) is the bathroom's outside wall; (3,0,w) is between the bathroom and nothing.
    ed().toggleOpenRun('fl_0', [{ x: 2, y: 0, side: 'n' }, wallAt(0)]);
    expect(openings()).toEqual([{ floorId: 'fl_0', x: 2, y: 0, side: 'w', kind: 'open' }]);
    expect(ed().toggleOpenRun('fl_0', [{ x: 3, y: 0, side: 'w' }])).toBe(false);
    expect(ed().notices.at(-1)!.text).toMatch(/between two rooms/);
  });

  it('a door in the run becomes open; undo puts the door back', () => {
    ed().toggleOpening('fl_0', wallAt(1), 'door');
    ed().toggleOpenRun('fl_0', [wallAt(0), wallAt(1)]);
    expect(openings().map((o) => o.kind)).toEqual(['open', 'open']);
    ed().undoLast();
    expect(openings()).toEqual([{ floorId: 'fl_0', x: 2, y: 1, side: 'w', kind: 'door' }]);
  });

  it('a run starting on an open edge closes the open edges in it', () => {
    ed().toggleOpenRun('fl_0', [wallAt(0), wallAt(1)]);
    ed().toggleOpenRun('fl_0', [wallAt(1)]);
    expect(openings()).toEqual([{ floorId: 'fl_0', x: 2, y: 0, side: 'w', kind: 'open' }]);
    expect(ed().undo.at(-1)!.label).toBe('close 1 tile of open wall');
  });

  it('the door tool puts a door in an open wall', () => {
    ed().toggleOpenRun('fl_0', [wallAt(0)]);
    ed().toggleOpening('fl_0', wallAt(0), 'door');
    expect(openings().map((o) => o.kind)).toEqual(['door']);
    expect(ed().undo.at(-1)!.label).toBe('put a door in an open wall');
  });
});
