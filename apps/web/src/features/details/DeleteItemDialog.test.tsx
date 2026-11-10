import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { House } from '../../api/types';
import { useData } from '../../store/data';
import { resetEditorForTests, useEditor } from '../../store/editor';
import { useUi } from '../../store/ui';
import { dishwasher, seedStore, snapshot } from '../../test/fixtures';
import { DeleteItemDialog } from './DeleteItemDialog';

const placedHouse: House = {
  ...snapshot.house!,
  placements: [{ itemId: 'it_dish', floorId: 'fl_0', x: 1, y: 0, rotation: 0 }],
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** Route fetch by "METHOD path"; returns the log of calls in order. */
function server(routes: Record<string, () => Response>) {
  const log: { call: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${url}`;
      log.push({ call, body: init?.body ? JSON.parse(init.body as string) : null });
      const route = routes[call];
      return route ? Promise.resolve(route()) : Promise.reject(new Error(`unexpected ${call}`));
    }),
  );
  return log;
}

const open = () => {
  const item = useData.getState().model!.items.get('it_dish')!;
  return render(<DeleteItemDialog item={item} onClose={() => {}} />);
};
const confirm = () => userEvent.click(screen.getByRole('button', { name: 'Delete', hidden: true }));

describe('delete item', () => {
  beforeEach(() => {
    resetEditorForTests();
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
  });
  afterEach(() => {
    resetEditorForTests();
    vi.unstubAllGlobals();
  });

  it('an unplaced item: the note goes to the trash with If-Match; panel closes, notice shown', async () => {
    seedStore();
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    useUi.getState().select({ kind: 'item', id: 'it_dish' });
    const log = server({ 'DELETE /api/items/it_dish': () => new Response(null, { status: 204 }) });
    open();
    expect(screen.queryByText('It is taken off the plan.')).not.toBeInTheDocument();
    await confirm();
    await vi.waitFor(() => expect(useData.getState().model!.items.has('it_dish')).toBe(false));
    expect(log.map((l) => l.call)).toEqual(['DELETE /api/items/it_dish']);
    const f = vi.mocked(fetch);
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)['If-Match']).toBe(
      `"${dishwasher.etag}"`,
    );
    expect(useUi.getState().selection).toBeNull();
    expect(useEditor.getState().notices.at(-1)?.text).toMatch(/“Dishwasher” was deleted/);
  });

  it('a placed item is taken off the plan and saved first, then deleted', async () => {
    seedStore({ ...snapshot, house: placedHouse });
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    const log = server({
      'PUT /api/house': () => json({ ...placedHouse, placements: [] }, 200, { ETag: '"h2"' }),
      'DELETE /api/items/it_dish': () => new Response(null, { status: 204 }),
    });
    open();
    expect(screen.getByText('It is taken off the plan.')).toBeInTheDocument();
    await confirm();
    await vi.waitFor(() => expect(useData.getState().model!.items.has('it_dish')).toBe(false));
    expect(log.map((l) => l.call)).toEqual(['PUT /api/house', 'DELETE /api/items/it_dish']);
    expect((log[0]!.body as House).placements).toEqual([]);
  });

  it('if the layout can’t be saved, nothing is deleted', async () => {
    seedStore({ ...snapshot, house: placedHouse });
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    const log = server({ 'PUT /api/house': () => json({ detail: 'disk full' }, 500) });
    open();
    await confirm();
    expect(
      await screen.findByText(/couldn’t be saved, so nothing was deleted/),
    ).toBeInTheDocument();
    expect(log.map((l) => l.call)).toEqual(['PUT /api/house']);
    expect(useData.getState().model!.items.has('it_dish')).toBe(true);
  });

  it('a note changed meanwhile (412) is not deleted, and says so', async () => {
    seedStore();
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    server({ 'DELETE /api/items/it_dish': () => json({ detail: 'changed' }, 412) });
    open();
    await confirm();
    expect(await screen.findByText(/changed just now, so it wasn’t deleted/)).toBeInTheDocument();
    expect(useData.getState().model!.items.has('it_dish')).toBe(true);
  });
});
