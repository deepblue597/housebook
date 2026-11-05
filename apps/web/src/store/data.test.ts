import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshot } from '../test/fixtures';
import { useData } from './data';

const reset = () =>
  useData.setState({ state: 'loading', model: null, etag: null, error: null, loadedAt: null });

describe('snapshot loading', () => {
  afterEach(reset);

  it('sends If-None-Match and keeps the model on 304', async () => {
    reset();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot), { status: 200, headers: { ETag: '"v1"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);

    await useData.getState().load();
    const model = useData.getState().model;
    expect(model?.items.size).toBe(3);
    await useData.getState().load();
    expect(useData.getState().model).toBe(model);
    const headers = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"v1"');
    vi.unstubAllGlobals();
  });

  it('reports an error state when the first load fails, keeps data on later failures', async () => {
    reset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await useData.getState().load();
    expect(useData.getState().state).toBe('error');

    useData.setState({ state: 'ready', model: { items: new Map() } as never });
    await useData.getState().load();
    expect(useData.getState().state).toBe('ready');
    expect(useData.getState().error).toMatch(/503/);
    vi.unstubAllGlobals();
  });
});
