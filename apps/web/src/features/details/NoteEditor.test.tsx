import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../api/types';
import { useData } from '../../store/data';
import { dishwasher, seedStore } from '../../test/fixtures';
import { useDrafts } from './drafts';
import { ItemDetails } from './ItemDetails';

const dish: Item = {
  ...dishwasher,
  etag: 'v1',
  frontmatter: { housebook_id: 'it_dish', name: 'Dishwasher', brand: 'Bosch', model: 'SMS4' },
  body: 'old body',
};

const renderItem = (item: Item = dish) =>
  render(
    <ItemDetails
      item={item}
      model={useData.getState().model!}
      headingRef={null}
      onClose={() => {}}
    />,
  );

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** Answers PATCH with the queued responses in order, GET of the item with `latest`. */
function server(patches: Response[], latest?: Item) {
  const f = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Promise.resolve(patches.shift()!);
    if (url === '/api/items/it_dish' && latest) return Promise.resolve(json(latest));
    return Promise.reject(new Error(`unexpected ${init?.method ?? 'GET'} ${url}`));
  });
  vi.stubGlobal('fetch', f);
  const patchCalls = () =>
    f.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([, init]) => ({
        ifMatch: (init!.headers as Record<string, string>)['If-Match'],
        body: JSON.parse(init!.body as string) as unknown,
      }));
  return { f, patchCalls };
}

const editor = () => useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
const field = (name: string) => screen.getByLabelText(name);
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('note editor', () => {
  beforeEach(() => {
    seedStore();
    useDrafts.setState({ drafts: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('viewers see no Edit button', () => {
    renderItem();
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  it('a stale note can’t be edited', () => {
    editor();
    renderItem({ ...dish, stale: true, parseError: 'bad yaml' });
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeDisabled();
  });

  it('sends only what changed, with If-Match, and shows the saved item', async () => {
    editor();
    const { patchCalls } = server([
      json({ ...dish, etag: 'v2', name: 'Dishwasher', fields: { brand: 'Siemens' } }),
    ]);
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    const form = screen.getByRole('form', { name: 'Edit note' });
    expect(field('Brand')).toHaveValue('Bosch');
    await userEvent.clear(field('Brand'));
    await userEvent.type(field('Brand'), 'Siemens');
    await userEvent.clear(field('Notes (Markdown)'));
    await userEvent.type(field('Notes (Markdown)'), 'new body');
    expect(within(form).getByText('2 changes')).toBeInTheDocument();
    await save();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(patchCalls()).toEqual([
      { ifMatch: '"v1"', body: { frontmatter: { brand: 'Siemens' }, body: 'new body' } },
    ]);
    expect(useData.getState().model!.items.get('it_dish')!.etag).toBe('v2');
    expect(useDrafts.getState().drafts).toEqual({});
    expect(screen.queryByRole('form', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  it('saving without changes writes nothing', async () => {
    editor();
    const { f } = server([]);
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await save();
    expect(await screen.findByText(/Nothing changed/)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('checks values before sending', async () => {
    editor();
    const { f } = server([]);
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(field('Check every'), 'monthly');
    await save();
    expect(screen.getByText('Fix the marked fields first.')).toBeInTheDocument();
    expect(field('Check every')).toHaveAttribute('aria-invalid', 'true');
    await vi.waitFor(() => expect(field('Check every')).toHaveFocus());
    expect(f).not.toHaveBeenCalled();
  });

  it('changed elsewhere, other fields: merged and saved without asking', async () => {
    editor();
    const theirs = { ...dish, etag: 'v2', frontmatter: { ...dish.frontmatter, model: 'SX1' } };
    const { patchCalls } = server(
      [json({ detail: 'changed' }, 412), json({ ...theirs, etag: 'v3' })],
      theirs,
    );
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.clear(field('Brand'));
    await userEvent.type(field('Brand'), 'Siemens');
    await save();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(patchCalls()).toEqual([
      { ifMatch: '"v1"', body: { frontmatter: { brand: 'Siemens' } } },
      { ifMatch: '"v2"', body: { frontmatter: { brand: 'Siemens' } } },
    ]);
  });

  it('changed elsewhere, same field: shows both; "Use theirs" takes their value', async () => {
    editor();
    const theirs = { ...dish, etag: 'v2', frontmatter: { ...dish.frontmatter, brand: 'Miele' } };
    const { patchCalls } = server([json({ detail: 'changed' }, 412)], theirs);
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.clear(field('Brand'));
    await userEvent.type(field('Brand'), 'Siemens');
    await save();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Theirs: Miele · yours: Siemens');
    await vi.waitFor(() => expect(alert).toHaveFocus());
    await userEvent.click(within(alert).getByRole('button', { name: 'Use theirs' }));
    expect(field('Brand')).toHaveValue('Miele');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(patchCalls()).toHaveLength(1);
  });

  it('the draft outlives the panel', async () => {
    editor();
    server([]);
    const first = renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(field('Serial number'), 'S-1');
    first.unmount();
    renderItem();
    expect(field('Serial number')).toHaveValue('S-1');
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it('server field errors appear next to the field', async () => {
    editor();
    server([
      json(
        {
          detail: [
            { type: 'value_error', loc: ['body', 'frontmatter', 'serial'], msg: 'too long' },
          ],
        },
        422,
      ),
    ]);
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(field('Serial number'), 'S-1');
    await save();
    expect(await screen.findByText('too long')).toBeInTheDocument();
    expect(field('Serial number')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('form', { name: 'Edit note' })).toBeInTheDocument();
  });
});
