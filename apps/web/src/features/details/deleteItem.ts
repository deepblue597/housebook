/**
 * Delete an item (D32): take it off the plan and save the layout, then move its note and
 * attachments to the trash (DELETE /api/items/{id}). That order (D8) never leaves a placement
 * without a note, so no "note missing" ghost appears, not even briefly.
 */
import { ApiError } from '../../api/client';
import { useData } from '../../store/data';
import { canEdit, markNoteDeleted, useEditor } from '../../store/editor';
import { useDrafts } from './drafts';

export class DeleteError extends Error {}

const placed = (id: string) =>
  (useData.getState().model?.snapshot.house?.placements ?? []).some((p) => p.itemId === id);

/** Save pending layout edits, waiting for a save already in flight. */
async function layoutSaved(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    await useEditor.getState().saveNow();
    const { pending, save } = useEditor.getState();
    if (save === 'error') return false;
    if (pending.length === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function deleteItem(id: string): Promise<void> {
  if (placed(id)) {
    if (!canEdit())
      throw new DeleteError(
        'The layout can’t be changed right now, so the item can’t be taken off the plan first.',
      );
    // An item can be placed more than once (a hand edit); take every copy off.
    for (let i = 0; i < 10 && placed(id); i++) useEditor.getState().unplaceItem(id);
    if (!(await layoutSaved()) || placed(id))
      throw new DeleteError('Taking it off the plan couldn’t be saved, so nothing was deleted.');
  }
  // The newest version we know: live sync keeps it current while the dialog is open.
  const item = useData.getState().model?.items.get(id);
  if (!item) return; // deleted elsewhere meanwhile
  try {
    await useData.getState().deleteItem(id, item.etag);
    markNoteDeleted(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      markNoteDeleted(id);
      return;
    }
    if (e instanceof ApiError && e.status === 412)
      throw new DeleteError(
        'The note was changed just now, so it wasn’t deleted. It is off the plan (in the Unplaced tray); look at it and try again.',
      );
    if (e instanceof ApiError && e.status === 403)
      throw new DeleteError('You can only view this house.');
    throw new DeleteError(
      e instanceof ApiError
        ? `The server refused: ${e.detail ?? e.message}`
        : 'The server couldn’t be reached; nothing was deleted.',
    );
  } finally {
    // Whatever happened to the note, a draft of it is no use after a confirmed delete.
    if (!useData.getState().model?.items.has(id)) useDrafts.getState().drop(id);
  }
}
