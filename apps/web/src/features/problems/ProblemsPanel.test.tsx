import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Problem } from '../../api/types';
import { useData } from '../../store/data';
import { useUi } from '../../store/ui';
import { seedStore } from '../../test/fixtures';
import ProblemsPanel from './ProblemsPanel';
import { groupProblems } from './problemText';

const PROBLEMS: Problem[] = [
  {
    kind: 'note_parse_error',
    severity: 'error',
    message: 'bad YAML',
    path: 'House/A.md',
    itemId: 'it_dish',
  },
  { kind: 'missing_note', severity: 'warning', message: 'no note', itemId: 'it_gone' },
  { kind: 'not_adopted', severity: 'info', message: 'needs an id', path: 'House/New.md' },
  { kind: 'note_parse_error', severity: 'error', message: 'too big', path: 'House/B.md' },
];

const serve = (list: Problem[]) =>
  new Response(
    JSON.stringify({ problems: list, count: list.length, scannedAt: '2026-11-06T10:00:00Z' }),
  );

describe('problems panel', () => {
  beforeEach(() => {
    seedStore();
    // jsdom's <dialog> has no showModal/close; a closed dialog's content is hidden.
    Object.assign(HTMLDialogElement.prototype, {
      showModal(this: HTMLDialogElement) {
        this.open = true;
      },
      close(this: HTMLDialogElement) {
        this.open = false;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('groups by kind in the server order', () => {
    expect(groupProblems(PROBLEMS).map((g) => [g.kind, g.problems.length])).toEqual([
      ['note_parse_error', 2],
      ['missing_note', 1],
      ['not_adopted', 1],
    ]);
  });

  it('lists problems with readable titles; viewers get no Adopt button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serve(PROBLEMS)));
    render(<ProblemsPanel onClose={() => {}} />);
    const parse = await screen.findByRole('region', { name: 'Notes that can’t be read (2)' });
    expect(parse).toHaveTextContent('bad YAML');
    expect(parse).toHaveTextContent('House/B.md');
    expect(screen.getByRole('region', { name: 'Notes not yet adopted (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adopt' })).not.toBeInTheDocument();
  });

  it('“Show” opens the item', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serve(PROBLEMS)));
    const onClose = vi.fn();
    render(<ProblemsPanel onClose={onClose} />);
    const parse = await screen.findByRole('region', { name: /Notes that can’t be read/ });
    await userEvent.click(within(parse).getByRole('button', { name: 'Show Dishwasher' }));
    expect(useUi.getState().selection).toEqual({ kind: 'item', id: 'it_dish' });
    expect(onClose).toHaveBeenCalled();
  });

  it('editors adopt a note explicitly; the list is refetched', async () => {
    useData.setState({ me: { user: 'e', role: 'editor', authMode: 'none' } });
    const adopted = {
      ...useData.getState().model!.snapshot.items[0]!,
      id: 'it_new01',
      name: 'New',
    };
    const f = vi
      .fn()
      .mockResolvedValueOnce(serve(PROBLEMS))
      .mockResolvedValueOnce(new Response(JSON.stringify(adopted)))
      .mockResolvedValueOnce(serve(PROBLEMS.filter((p) => p.kind !== 'not_adopted')));
    vi.stubGlobal('fetch', f);
    render(<ProblemsPanel onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adopt' }));
    expect(f.mock.calls[1]![0]).toBe('/api/items/adopt');
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      path: 'House/New.md',
    });
    expect(useData.getState().model!.items.has('it_new01')).toBe(true);
    expect(await screen.findByText('Adopted House/New.md as it_new01.')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.queryByRole('region', { name: /not yet adopted/ })).not.toBeInTheDocument(),
    );
  });
});
