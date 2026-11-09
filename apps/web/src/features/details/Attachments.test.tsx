import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../api/types';
import { useData } from '../../store/data';
import { dishwasher, seedStore } from '../../test/fixtures';
import { Attachments } from './Attachments';

const manual = {
  name: 'manual.pdf',
  size: 2048,
  listed: true,
  url: '/api/items/it_dish/attachments/manual.pdf',
};
const item: Item = { ...dishwasher, attachments: [manual] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pdf = (name = 'receipt.pdf', size = 10) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' });

function server(...responses: Response[]) {
  const f = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(responses.shift()!));
  vi.stubGlobal('fetch', f);
  return f;
}

const show = (it: Item = item, editor = true) => render(<Attachments item={it} editor={editor} />);
const picker = () => screen.getByLabelText('Files to attach');

describe('attachments', () => {
  beforeEach(() => seedStore());
  afterEach(() => vi.unstubAllGlobals());

  it('viewers get no add or remove controls, and no section without files', () => {
    show(item, false);
    expect(screen.queryByRole('button', { name: 'Add files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove manual.pdf' })).not.toBeInTheDocument();
    show({ ...item, attachments: [] }, false);
    expect(screen.getAllByRole('heading', { name: 'Attachments' })).toHaveLength(1);
  });

  it('editors see the section even without files, with a hint', () => {
    show({ ...item, attachments: [] });
    expect(screen.getByRole('button', { name: 'Add files' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/PDF, JPEG, PNG, WebP or HEIC/);
  });

  it('uploads each file as the raw body with its name, one after the other', async () => {
    const after = {
      ...item,
      etag: 'v2',
      attachments: [manual, { ...manual, name: 'receipt.pdf' }],
    };
    const f = server(json(after, 201), json(after, 201));
    show();
    await userEvent.upload(picker(), [pdf('receipt.pdf'), pdf('a b.pdf')]);
    expect(await screen.findByText('2 files added.')).toBeInTheDocument();
    expect(f.mock.calls.map(([url]) => url)).toEqual([
      '/api/items/it_dish/attachments?name=receipt.pdf',
      '/api/items/it_dish/attachments?name=a%20b.pdf',
    ]);
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
    expect(init.body).toBeInstanceOf(File);
    expect(useData.getState().model!.items.get('it_dish')!.etag).toBe('v2');
  });

  it('says which files failed and why; too large ones are never sent', async () => {
    const f = server(json({ detail: 'only PDF…' }, 415));
    show();
    await userEvent.upload(picker(), [pdf('big.pdf', 25 * 1024 * 1024 + 1), pdf('notes.pdf')]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('big.pdf: too large (25 MB at most).');
    expect(alert).toHaveTextContent(
      'notes.pdf: only PDF, JPEG, PNG, WebP or HEIC files can be attached.',
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('remove asks first, then moves the file to the trash', async () => {
    const f = server(json({ ...item, attachments: [] }));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Remove manual.pdf' }));
    const confirm = screen.getByRole('button', { name: 'Remove manual.pdf' });
    expect(
      within(confirm.parentElement!).getByRole('button', { name: 'Keep' }),
    ).toBeInTheDocument();
    await userEvent.click(confirm);
    expect(await screen.findByText('manual.pdf moved to the trash.')).toBeInTheDocument();
    expect(f).toHaveBeenCalledWith(
      '/api/items/it_dish/attachments/manual.pdf',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('a shared file outside the item’s folder is explained, not deleted', async () => {
    server(json({ detail: 'x', reason: 'not_in_folder' }, 409));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Remove manual.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove manual.pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /may be shared, so it wasn’t deleted/,
    );
  });
});
