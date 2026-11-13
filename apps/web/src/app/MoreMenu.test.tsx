import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../api/types';
import { useData } from '../store/data';
import { seedStore } from '../test/fixtures';
import { logOut } from './logout';
import { MoreMenu } from './MoreMenu';

const me = (over: Partial<Me>): Me => ({
  user: null,
  name: null,
  role: 'viewer',
  authMode: 'none',
  logoutUrl: null,
  ...over,
});

async function openMenu() {
  render(<MoreMenu />);
  await userEvent.click(screen.getByRole('button', { name: 'More' }));
}

describe('who is signed in (D48)', () => {
  beforeEach(() => seedStore());
  afterEach(() => vi.unstubAllGlobals());

  it('shows the name and a Log out link with a login', async () => {
    useData.setState({
      me: me({ user: 'anna', name: 'Anna K', authMode: 'oidc', logoutUrl: '/api/auth/logout' }),
    });
    await openMenu();
    expect(screen.getByText(/Signed in as/)).toHaveTextContent('Signed in as Anna K');
    expect(screen.getByRole('link', { name: 'Log out' })).toHaveAttribute(
      'href',
      '/api/auth/logout',
    );
  });

  it('shows the user when the provider sent no name, and no link without a logout URL', async () => {
    useData.setState({ me: me({ user: 'kid', authMode: 'proxy' }) });
    await openMenu();
    expect(screen.getByText(/Signed in as/)).toHaveTextContent('Signed in as kid');
    expect(screen.queryByRole('link', { name: 'Log out' })).toBeNull();
  });

  it('shows nothing without a login', async () => {
    useData.setState({ me: me({ role: 'editor' }) });
    await openMenu();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('forgets the offline copy before leaving', async () => {
    const order: string[] = [];
    vi.stubGlobal('location', { ...window.location, assign: (u: string) => order.push(`go ${u}`) });
    await logOut('/api/auth/logout', () => {
      order.push('clear');
      return Promise.resolve();
    });
    expect(order).toEqual(['clear', 'go /api/auth/logout']);
  });
});
