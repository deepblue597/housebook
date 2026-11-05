import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useData } from '../../store/data';
import { dishwasher, seedStore } from '../../test/fixtures';
import MarkdownBody from './MarkdownBody';
import { resolveWikilink } from './links';

describe('MarkdownBody', () => {
  beforeEach(() => seedStore());

  const renderBody = (onNavigate = vi.fn()) => {
    const model = useData.getState().model!;
    const { container } = render(
      <MarkdownBody
        body={dishwasher.body}
        resolve={(l) => resolveWikilink(model, dishwasher, l)}
        onNavigate={onNavigate}
      />,
    );
    return { container, onNavigate };
  };

  it('renders Markdown with the note headings below the panel title', () => {
    renderBody();
    expect(screen.getByRole('heading', { level: 3, name: 'Quick help' })).toBeInTheDocument();
    expect(screen.getByText('E15').tagName).toBe('STRONG');
  });

  it('never renders raw HTML or javascript: links', () => {
    const { container } = renderBody();
    expect(container.querySelector('script, b')).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByText('bad')).toBeInTheDocument();
    const ok = screen.getByRole('link', { name: 'ok' });
    expect(ok).toHaveAttribute('target', '_blank');
    expect(ok).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links resolvable wikilinks in-app and leaves the rest as text', async () => {
    const { onNavigate } = renderBody();
    const link = screen.getByRole('link', { name: 'Fridge' });
    expect(link).toHaveAttribute('href', '/i/it_fridge');
    link.click();
    expect(onNavigate).toHaveBeenCalledWith('/i/it_fridge');
    expect(screen.queryByRole('link', { name: 'Nowhere' })).not.toBeInTheDocument();
    expect(screen.getByText(/Nowhere/)).toBeInTheDocument();
    await Promise.resolve();
  });
});
