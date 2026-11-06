import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useData } from '../../store/data';
import { dishwasher, seedStore } from '../../test/fixtures';
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
