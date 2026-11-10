import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarDialog } from './CalendarDialog';

const URL_ = 'https://house.example/api/calendar.ics?token=abc';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch stub answering by method; records the calls. */
function server(answers: Record<string, Array<() => Response>>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      calls.push(key);
      const next = answers[key]?.shift();
      return Promise.resolve(next ? next() : new Response('{}', { status: 500 }));
    }),
  );
  return calls;
}

describe('CalendarDialog (D40)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes a link and shows it once, with a Copy button', async () => {
    const calls = server({
      'GET /api/calendar/link': [() => json({ exists: false, createdAt: null, url: null })],
      'POST /api/calendar/link': [
        () => json({ exists: true, createdAt: '2026-11-10T09:00:00Z', url: URL_ }, 201),
      ],
    });
    const user = userEvent.setup();
    // After setup: user-event installs its own clipboard.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<CalendarDialog onClose={() => {}} />);
    await user.click(
      await screen.findByRole('button', { name: 'Make my calendar link', hidden: true }),
    );
    expect(await screen.findByLabelText('Calendar link')).toHaveValue(URL_);
    expect(screen.getByText(/shown only now/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy', hidden: true }));
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
    expect(calls).toEqual(['GET /api/calendar/link', 'POST /api/calendar/link']);
  });

  it('an existing link can only be replaced or turned off', async () => {
    const calls = server({
      'GET /api/calendar/link': [
        () => json({ exists: true, createdAt: '2026-11-01T08:00:00Z', url: null }),
      ],
      'DELETE /api/calendar/link': [() => new Response(null, { status: 204 })],
    });
    const user = userEvent.setup();
    render(<CalendarDialog onClose={() => {}} />);
    expect(await screen.findByText(/You made a calendar link on 1 Nov 2026/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Calendar link')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Make a new link', hidden: true }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn the link off', hidden: true }));
    expect(
      await screen.findByRole('button', { name: 'Make my calendar link', hidden: true }),
    ).toBeInTheDocument();
    expect(calls).toContain('DELETE /api/calendar/link');
  });

  it('says why when the server refuses', async () => {
    server({ 'GET /api/calendar/link': [() => json({ detail: 'Not authenticated' }, 401)] });
    render(<CalendarDialog onClose={() => {}} />);
    expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent(
      'Couldn’t check: Not authenticated.',
    );
  });
});
