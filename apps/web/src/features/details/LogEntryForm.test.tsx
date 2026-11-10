import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useData } from '../../store/data';
import { dishwasher, seedStore, snapshot } from '../../test/fixtures';
import { ItemDetails } from './ItemDetails';

const renderItem = (item = dishwasher) =>
  render(
    <ItemDetails
      item={item}
      model={useData.getState().model!}
      headingRef={null}
      onClose={() => {}}
    />,
  );

describe('maintenance log entry', () => {
  beforeEach(() => seedStore());
  afterEach(() => vi.unstubAllGlobals());

  it('viewers (and an unknown role) see no write UI', () => {
    renderItem();
    expect(screen.queryByRole('form', { name: 'Add to maintenance log' })).not.toBeInTheDocument();
    useData.setState({ me: { user: 'v', role: 'viewer', authMode: 'proxy' } });
    renderItem();
    expect(screen.queryByRole('form', { name: 'Add to maintenance log' })).not.toBeInTheDocument();
  });

  it('editors add an entry; the item is updated from the response', async () => {
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    const written = { ...dishwasher, etag: 'w', body: '## Maintenance log\n- 2026-11-06 Filter' };
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(written), { status: 200 }));
    vi.stubGlobal('fetch', f);
    renderItem();
    const form = screen.getByRole('form', { name: 'Add to maintenance log' });
    await userEvent.type(screen.getByLabelText('Maintenance log entry'), 'Filter');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Added to the maintenance log.')).toBeInTheDocument();
    expect(f).toHaveBeenCalledWith(
      '/api/items/it_dish/log',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useData.getState().model!.items.get('it_dish')!.etag).toBe('w');
    expect(form.querySelector('input')).toHaveValue('');
  });

  it('shows why a write failed', async () => {
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('{"detail":"x","reason":"unparseable"}', { status: 409 })),
    );
    renderItem();
    await userEvent.type(screen.getByLabelText('Maintenance log entry'), 'Filter');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/fix it in an editor first/)).toBeInTheDocument();
  });

  it('an empty entry is not sent', async () => {
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    renderItem();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Write what was done first.')).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('next check after a log entry (D39)', () => {
  // Every 6 months, next check set by hand to 1 Nov 2026.
  const item = {
    ...dishwasher,
    fields: { ...dishwasher.fields, next_check: '2026-11-01', check_every: '6m' },
  };
  const json = (body: unknown, status = 200, etag?: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: etag ? { ETag: `"${etag}"` } : undefined,
    });
  const written = { ...item, etag: 'w', body: '## Maintenance log\n- 2026-11-06 Filter' };

  /** fetch stub: answers by method and URL, records the calls. */
  function server(routes: Record<string, Array<() => Response>>) {
    const calls: { key: string; init: RequestInit }[] = [];
    const f = vi.fn((url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      calls.push({ key, init });
      const next = routes[key]?.shift();
      return Promise.resolve(next ? next() : new Response('{}', { status: 500 }));
    });
    vi.stubGlobal('fetch', f);
    return calls;
  }

  async function addEntry(date: string) {
    renderItem(item);
    await userEvent.type(screen.getByLabelText('Maintenance log entry'), 'Filter');
    fireEvent.change(screen.getByLabelText('Date (default today)'), { target: { value: date } });
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  }

  beforeEach(() => {
    seedStore({ ...snapshot, items: [item] });
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
  });

  it('offers the entry date plus the interval and sets it against the logged version', async () => {
    const set = { ...written, etag: 's', fields: { ...written.fields, next_check: '2027-05-06' } };
    const calls = server({
      'POST /api/items/it_dish/log': [() => json(written)],
      'PATCH /api/items/it_dish': [() => json(set)],
    });
    await addEntry('2026-11-06');
    expect(
      await screen.findByText('Added to the maintenance log. Set the next check to 6 May 2027?'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/set to 1 Nov 2026 now\. Checks are every 6 months/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set next check to 6 May 2027' }));
    expect(await screen.findByText('Next check set to 6 May 2027.')).toBeInTheDocument();
    const patch = calls.find((c) => c.key === 'PATCH /api/items/it_dish')!;
    expect(JSON.parse(patch.init.body as string)).toEqual({
      frontmatter: { next_check: '2027-05-06' },
    });
    expect(new Headers(patch.init.headers).get('If-Match')).toBe('"w"');
    expect(useData.getState().model!.items.get('it_dish')!.fields.next_check).toBe('2027-05-06');
  });

  it('"Keep" leaves the note alone', async () => {
    const calls = server({ 'POST /api/items/it_dish/log': [() => json(written)] });
    await addEntry('2026-11-06');
    await userEvent.click(await screen.findByRole('button', { name: 'Keep 1 Nov 2026' }));
    const form = screen.getByRole('form', { name: 'Add to maintenance log' });
    expect(within(form).getByRole('status')).toHaveTextContent(/^Added to the maintenance log\.$/);
    expect(screen.queryByRole('button', { name: /Set next check/ })).not.toBeInTheDocument();
    expect(calls.map((c) => c.key)).toEqual(['POST /api/items/it_dish/log']);
  });

  it('no offer for an old service that would move the date back', async () => {
    server({ 'POST /api/items/it_dish/log': [() => json(written)] });
    await addEntry('2025-01-10');
    expect(await screen.findByText('Added to the maintenance log.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set next check/ })).not.toBeInTheDocument();
  });

  it('changed meanwhile: retries on the new version if next_check is untouched', async () => {
    const other = { ...written, etag: 'o', fields: { ...written.fields, brand: 'Siemens' } };
    const calls = server({
      'POST /api/items/it_dish/log': [() => json(written)],
      'PATCH /api/items/it_dish': [
        () => json({ detail: 'changed' }, 412),
        () => json({ ...other, etag: 's' }),
      ],
      'GET /api/items/it_dish': [() => json(other, 200, 'o')],
    });
    await addEntry('2026-11-06');
    await userEvent.click(await screen.findByRole('button', { name: /Set next check/ }));
    expect(await screen.findByText('Next check set to 6 May 2027.')).toBeInTheDocument();
    const patches = calls.filter((c) => c.key === 'PATCH /api/items/it_dish');
    expect(patches.map((c) => new Headers(c.init.headers).get('If-Match'))).toEqual(['"w"', '"o"']);
  });

  it('changed meanwhile, next_check included: leaves it and says so', async () => {
    const other = {
      ...written,
      etag: 'o',
      fields: { ...written.fields, next_check: '2026-12-01' },
    };
    const calls = server({
      'POST /api/items/it_dish/log': [() => json(written)],
      'PATCH /api/items/it_dish': [() => json({ detail: 'changed' }, 412)],
      'GET /api/items/it_dish': [() => json(other, 200, 'o')],
    });
    await addEntry('2026-11-06');
    await userEvent.click(await screen.findByRole('button', { name: /Set next check/ }));
    expect(
      await screen.findByText(/changed meanwhile, so the next check was left/),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'PATCH /api/items/it_dish')).toHaveLength(1);
  });

  it('without an explicit next check, says where the next check moved to', async () => {
    const derived = {
      ...written,
      fields: { ...written.fields, next_check: null },
      status: {
        level: null,
        check: { state: 'scheduled' as const, date: '2027-05-06', days: 183, derived: true },
        warranty: null,
      },
    };
    server({ 'POST /api/items/it_dish/log': [() => json(derived)] });
    await addEntry('2026-11-06');
    expect(
      await screen.findByText('Added to the maintenance log. Next check: 6 May 2027.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set next check/ })).not.toBeInTheDocument();
  });
});
