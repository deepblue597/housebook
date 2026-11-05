import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUi } from '../../store/ui';
import { seedStore } from '../../test/fixtures';
import { ListView } from './ListView';

describe('ListView', () => {
  beforeEach(() => seedStore());

  it('groups items by floor and room', () => {
    render(<ListView />);
    expect(screen.getByRole('heading', { level: 2, name: /Ground/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kitchen/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dishwasher/ })).toHaveTextContent('Check overdue');
  });

  it('moves between entries with the arrow keys and opens with Enter', async () => {
    const user = userEvent.setup();
    render(<ListView />);
    const entries = screen.getAllByRole('button');
    entries[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(entries[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(entries.at(-1)).toHaveFocus();
    await user.keyboard('{Home}{ArrowDown}{Enter}');
    expect(useUi.getState().selection).toMatchObject({ kind: 'item' });
  });

  it('filters to search matches', () => {
    useUi.setState({ query: 'e15' });
    render(<ListView />);
    expect(screen.getByRole('status')).toHaveTextContent('1 item matches');
    expect(screen.queryByRole('button', { name: /Water heater/ })).not.toBeInTheDocument();
  });
});
