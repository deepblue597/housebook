import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUi } from '../../store/ui';
import { seedStore } from '../../test/fixtures';
import { SearchBox } from './SearchBox';

describe('SearchBox', () => {
  beforeEach(() => seedStore());

  it('lists matches for an error code and opens the chosen one with the keyboard', async () => {
    const user = userEvent.setup();
    render(<SearchBox />);
    const box = screen.getByRole('combobox');
    await user.type(box, 'e15');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Dishwasher'),
    ]);
    expect(box).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Enter}');
    expect(useUi.getState().selection).toEqual({ kind: 'item', id: 'it_dish' });
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  it('matches Greek without accents and clears on the second Escape', async () => {
    const user = userEvent.setup();
    render(<SearchBox />);
    const box = screen.getByRole('combobox');
    await user.type(box, 'ΘΕΡΜΟΣΙΦΩΝΑΣ');
    expect(screen.getByRole('option')).toHaveTextContent('Water heater');
    await user.keyboard('{Escape}');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<SearchBox />);
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });
});
