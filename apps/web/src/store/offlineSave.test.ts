import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api/types';
import { seedStore } from '../test/fixtures';
import { useData } from './data';
import { useEditor } from './editor';
import { SAVE_DELAY_MS, startOfflineSave } from './offlineSave';

describe('startOfflineSave', () => {
  let stop: () => void;
  const save = vi.fn<(s: Snapshot | null, at: Date) => Promise<void>>(() => Promise.resolve());

  beforeEach(() => {
    vi.useFakeTimers();
    save.mockClear();
    seedStore();
    useData.setState({ offlineAt: null });
    useEditor.setState({ pending: [] });
    stop = startOfflineSave(save);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('saves the data shortly after it changes, then only the time while unchanged', () => {
    const at = new Date('2026-11-13T10:00:00Z');
    useData.setState({ loadedAt: at });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe(useData.getState().model!.snapshot);
    expect(save.mock.calls[0]![1]).toBe(at);

    const later = new Date('2026-11-13T10:05:00Z');
    useData.setState({ loadedAt: later }); // a 304
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenLastCalledWith(null, later);
  });

  it('waits for a burst of changes to end', () => {
    for (let i = 0; i < 5; i++) {
      useData.setState({ loadedAt: new Date() });
      vi.advanceTimersByTime(SAVE_DELAY_MS / 2);
    }
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not save the offline copy back, nor a layout with unsaved edits', () => {
    useData.setState({ loadedAt: new Date(), offlineAt: new Date() });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).not.toHaveBeenCalled();

    useData.setState({ offlineAt: null });
    useEditor.setState({ pending: [{ entryId: 1, dir: 'do', cmd: {} }] as never });
    useData.setState({ loadedAt: new Date() });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).not.toHaveBeenCalled();

    // Saved: the layout shown is the server's again.
    useEditor.setState({ pending: [] });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves at once when the tab is hidden', () => {
    useData.setState({ loadedAt: new Date() });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(save).toHaveBeenCalledTimes(1);
  });
});
