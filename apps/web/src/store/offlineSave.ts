/**
 * Keeps the offline copy (offlineCache.ts, D47) up to date: whenever the data shown changes,
 * or is confirmed current again (a poll's 304, a focus), shortly after.
 *
 * Not saved: the offline copy itself (it isn't newer than what is stored), and a layout with
 * unsaved editor edits (the copy holds what the server has; it is saved once they are).
 */
import type { Snapshot } from '../api/types';
import { useData } from './data';
import { useEditor } from './editor';
import { saveOffline } from './offlineCache';

export const SAVE_DELAY_MS = 1_500;

export function startOfflineSave(save = saveOffline): () => void {
  let saved: Snapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const { model, loadedAt, offlineAt } = useData.getState();
    if (!model || !loadedAt || offlineAt || useEditor.getState().pending.length) return;
    const snapshot = model.snapshot === saved ? null : model.snapshot;
    saved = model.snapshot;
    void save(snapshot, loadedAt);
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  };
  // A phone may close a hidden tab without warning: save what is due right away.
  const onHide = () => {
    if (timer !== undefined && document.visibilityState === 'hidden') flush();
  };

  const offData = useData.subscribe((s, prev) => {
    if (s.model !== prev.model || s.loadedAt !== prev.loadedAt) schedule();
  });
  const offEditor = useEditor.subscribe((s, prev) => {
    if (prev.pending.length && !s.pending.length) schedule();
  });
  document.addEventListener('visibilitychange', onHide);
  return () => {
    offData();
    offEditor();
    document.removeEventListener('visibilitychange', onHide);
    if (timer !== undefined) clearTimeout(timer);
  };
}
