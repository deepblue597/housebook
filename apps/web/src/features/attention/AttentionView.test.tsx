import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../../store/ui';
import { heater, makeItem, seedStore, snapshot } from '../../test/fixtures';
import { AttentionView } from './AttentionView';

describe('AttentionView', () => {
  beforeEach(() => {
    // The fixture's "today", so the snapshot's status is used as is.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${snapshot.today}T12:00:00Z`));
    seedStore();
  });
  afterEach(() => vi.useRealTimers());

  it('shows overdue checks, then what is coming up, each with its item and place', () => {
    render(<AttentionView />);
    const overdue = screen.getByRole('region', { name: /Overdue/ });
    const row = within(overdue).getByRole('button', { name: /Dishwasher/ });
    expect(row).toHaveTextContent('Kitchen · Ground');
    expect(row).toHaveTextContent('Check overdue by 3 days');
    expect(row).toHaveTextContent('Was due 1 Nov 2026');
    const upcoming = screen.getByRole('region', { name: /Coming up/ });
    expect(within(upcoming).getByRole('button', { name: /Dishwasher/ })).toHaveTextContent(
      'Warranty ends in 27 days',
    );
    // Nothing due: not listed.
    expect(screen.queryByRole('button', { name: /Fridge|Water heater/ })).not.toBeInTheDocument();
  });

  it('opens the item from an entry and moves between entries with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<AttentionView />);
    const rows = screen.getAllByRole('button');
    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(useUi.getState().selection).toEqual({ kind: 'item', id: 'it_dish' });
  });

  it('marks a check date that comes from the check interval', () => {
    const boiler = makeItem({
      id: 'it_boil',
      name: 'Boiler',
      fields: { check_every: '1y' },
      status: {
        level: 'due_soon',
        check: { state: 'due_soon', date: '2026-11-20', days: 16, derived: true },
        warranty: null,
      },
      location: { floorId: 'fl_0', roomId: null, x: 3, y: 1, rotation: 0 },
    });
    seedStore({ ...snapshot, items: [boiler] });
    render(<AttentionView />);
    const row = screen.getByRole('button', { name: /Boiler/ });
    expect(row).toHaveTextContent('Check due in 16 days');
    expect(row).toHaveTextContent('Due 20 Nov 2026 (every 1y)');
    expect(row).toHaveTextContent('Ground');
  });

  it('says so when nothing needs attention, and follows the search', () => {
    useUi.setState({ query: 'θερμοσίφωνας' });
    render(<AttentionView />);
    expect(screen.getByRole('status')).toHaveTextContent('match the search');
    expect(
      screen.getByText(/Nothing needs attention among the matching items/),
    ).toBeInTheDocument();
    expect(heater.status.level).toBeNull();
  });
});
