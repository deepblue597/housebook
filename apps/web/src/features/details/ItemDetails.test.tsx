import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useData } from '../../store/data';
import { dishwasher, fridge, seedStore } from '../../test/fixtures';
import { ItemDetails } from './ItemDetails';

describe('ItemDetails', () => {
  beforeEach(() => {
    seedStore();
    // Freeze "today" to the snapshot's date so the server status is used as is.
    vi.useFakeTimers({ now: new Date('2026-11-04T12:00:00Z'), toFake: ['Date'] });
  });

  const renderItem = (item = dishwasher) =>
    render(
      <ItemDetails
        item={item}
        model={useData.getState().model!}
        headingRef={null}
        onClose={() => {}}
      />,
    );

  it('shows status as text, never colour alone', () => {
    renderItem();
    const chips = screen.getByRole('list', { name: 'Status' });
    expect(chips).toHaveTextContent('Check overdue by 3 days');
    expect(chips).toHaveTextContent('Warranty ends in 27 days');
  });

  it('drops links with disallowed schemes and keeps allowed ones', () => {
    renderItem();
    expect(screen.queryByRole('link', { name: 'Manual' })).not.toBeInTheDocument();
    const support = screen.getByRole('link', { name: 'Support' });
    expect(support).toHaveAttribute('href', 'https://bosch.example/');
    expect(support).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('offers "Open in Obsidian" only when the API gives a vault URL', () => {
    const { unmount } = renderItem();
    expect(screen.queryByRole('link', { name: 'Open in Obsidian' })).not.toBeInTheDocument();
    unmount();
    renderItem(fridge);
    expect(screen.getByRole('link', { name: 'Open in Obsidian' })).toHaveAttribute(
      'href',
      fridge.obsidianUrl,
    );
  });

  it('shows serial and model as specs', () => {
    renderItem();
    expect(screen.getByText('FD 0412 00123')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Dishwasher' })).toBeInTheDocument();
  });
});
