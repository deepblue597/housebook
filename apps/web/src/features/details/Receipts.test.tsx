import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item, Receipt } from '../../api/types';
import { useData } from '../../store/data';
import { dishwasher, seedStore, snapshot } from '../../test/fixtures';
import { Receipts } from './Receipts';

const PAPERLESS = 'https://paperless.example';
const invoice = `${PAPERLESS}/documents/12/details`;
const gone = `${PAPERLESS}/documents/99/details`;
const shop = 'https://shop.example/order/77';

const withReceipts = (...receipts: string[]): Item => ({
  ...dishwasher,
  fields: { ...dishwasher.fields, receipts },
});

const found: Receipt = {
  url: invoice,
  documentId: 12,
  state: 'found',
  title: 'Dishwasher invoice',
  created: '2024-05-10',
  thumbUrl: '/api/items/it_dish/receipts/12/thumb',
  previewUrl: '/api/items/it_dish/receipts/12/preview',
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** A fake server, by URL; `patched` collects PATCH bodies and answers with the item after. */
function server({ receipts = [] as Receipt[] | 'down', search = [] as unknown[] } = {}) {
  const patched: unknown[] = [];
  const f = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/receipts'))
      return receipts === 'down' ? Promise.reject(new TypeError('offline')) : json({ receipts });
    if (url.startsWith('/api/paperless/search')) return json({ results: search });
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string) as {
        frontmatter: { receipts: string[] | null };
      };
      patched.push(body);
      return json({ ...withReceipts(...(body.frontmatter.receipts ?? [])), etag: 'v2' });
    }
    return json({ detail: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', f);
  return { f, patched };
}

const show = (item: Item, editor = true) => render(<Receipts item={item} editor={editor} />);

describe('receipts (D52)', () => {
  beforeEach(() => seedStore({ ...snapshot, paperlessUrl: PAPERLESS }));
  afterEach(() => vi.unstubAllGlobals());

  it('without receipts: nothing for viewers, or without Paperless; Link receipt for editors', () => {
    const { f } = server();
    seedStore({ ...snapshot, paperlessUrl: null });
    const { unmount } = show(dishwasher);
    expect(screen.queryByRole('heading', { name: 'Receipts' })).not.toBeInTheDocument();
    unmount();
    seedStore({ ...snapshot, paperlessUrl: PAPERLESS });
    show(dishwasher, false);
    expect(screen.queryByRole('heading', { name: 'Receipts' })).not.toBeInTheDocument();
    show(dishwasher);
    expect(screen.getByRole('button', { name: 'Link receipt' })).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled(); // no receipts: nothing to ask the server
    expect(screen.getByRole('status')).toHaveTextContent(/kept in Paperless/);
  });

  it('shows each receipt from Paperless, a missing one and a plain link', async () => {
    server({
      receipts: [
        found,
        { url: gone, documentId: 99, state: 'missing' },
        { url: shop, documentId: null, state: 'link' },
      ],
    });
    show(withReceipts(invoice, gone, shop), false);
    expect(
      await screen.findByRole('button', { name: 'View Dishwasher invoice' }),
    ).toBeInTheDocument();
    const [first, second, third] = screen.getAllByRole('listitem');
    expect(
      within(first!).getByRole('img', { name: 'First page of Dishwasher invoice', hidden: true }),
    ).toHaveAttribute('src', found.thumbUrl);
    expect(
      within(first!).getByRole('link', { name: 'Open in Paperless Dishwasher invoice' }),
    ).toHaveAttribute('href', invoice);
    expect(within(second!).getByText(/Not in Paperless any more/)).toBeInTheDocument();
    expect(within(second!).queryByRole('link')).not.toBeInTheDocument();
    expect(
      within(third!).getByRole('link', { name: 'Open shop.example/order/77' }),
    ).toHaveAttribute('href', shop);
    expect(screen.queryByRole('button', { name: /Unlink/ })).not.toBeInTheDocument();
  });

  it('offline: the links stay usable as they are', async () => {
    const { f } = server({ receipts: 'down' });
    show(withReceipts(invoice), false);
    await vi.waitFor(() =>
      expect(f).toHaveBeenCalledWith('/api/items/it_dish/receipts', expect.anything()),
    );
    expect(
      screen.getByRole('link', { name: `Open ${PAPERLESS.slice(8)}/documents/12/details` }),
    ).toHaveAttribute('href', invoice);
  });

  it('links a receipt found by searching Paperless', async () => {
    const { f, patched } = server({
      search: [
        {
          documentId: 12,
          title: 'Dishwasher invoice',
          created: '2024-05-10',
          url: invoice,
          thumbUrl: '/api/paperless/documents/12/thumb',
        },
      ],
    });
    show(dishwasher);
    await userEvent.click(await screen.findByRole('button', { name: 'Link receipt' }));
    const dialog = screen.getByText('Link a receipt from Paperless').closest('dialog')!;
    // The test DOM never opens a <dialog>, so typing doesn't reach it: set the value.
    fireEvent.change(
      within(dialog).getByRole('searchbox', { name: /Search Paperless/, hidden: true }),
      { target: { value: 'dish' } },
    );
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Link Dishwasher invoice', hidden: true }),
    );
    expect(await screen.findByText('Receipt linked.')).toBeInTheDocument();
    expect(patched).toEqual([{ frontmatter: { receipts: [invoice] } }]);
    const patch = f.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(patch[0]).toBe('/api/items/it_dish');
    expect((patch[1]!.headers as Record<string, string>)['If-Match']).toBe(`"${dishwasher.etag}"`);
    expect(f.mock.calls.some(([url]) => url === '/api/paperless/search?q=dish')).toBe(true);
    expect(useData.getState().model!.items.get('it_dish')!.fields.receipts).toEqual([invoice]);
  });

  it('marks receipts that are already linked', async () => {
    server({
      receipts: [found],
      search: [
        { documentId: 12, title: 'Dishwasher invoice', created: null, url: invoice, thumbUrl: '' },
      ],
    });
    show(withReceipts(invoice));
    await userEvent.click(await screen.findByRole('button', { name: 'Link receipt' }));
    expect(
      await screen.findByRole('button', { name: 'Dishwasher invoice: Linked', hidden: true }),
    ).toBeDisabled();
  });

  it('unlink asks first, and removes the key with the last receipt', async () => {
    const { patched } = server({ receipts: [found] });
    show(withReceipts(invoice));
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Dishwasher invoice' }));
    const confirm = screen.getByRole('button', { name: 'Unlink Dishwasher invoice' });
    expect(
      within(confirm.parentElement!).getByRole('button', { name: 'Keep' }),
    ).toBeInTheDocument();
    await userEvent.click(confirm);
    expect(await screen.findByText('Link removed.')).toBeInTheDocument();
    expect(patched).toEqual([{ frontmatter: { receipts: null } }]);
  });

  it('a note changed in the meantime is explained', async () => {
    const { f } = server({ receipts: [found] });
    f.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? json({ detail: 'changed' }, 412) : json({ receipts: [found] }),
    );
    show(withReceipts(invoice));
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Dishwasher invoice' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unlink Dishwasher invoice' }));
    expect(
      await screen.findByText('The note changed in the meantime. Try again.'),
    ).toBeInTheDocument();
  });
});
