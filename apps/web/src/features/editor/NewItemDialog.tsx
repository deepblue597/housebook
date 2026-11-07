/**
 * Naming a new item placed from the catalogue. D8 order: the note is created first
 * (POST /api/items), then its placement is added as an undoable command and saved with the
 * layout. If the layout save fails, the note is simply unplaced (it shows in the tray).
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { itemType, typeLabel } from '../../catalog/catalog';
import { Dialog } from '../../components/Dialog';
import { cellKey } from '../../domain/coords';
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { type NewItemDraft, useEditor } from '../../store/editor';

function Form({ draft }: { draft: NewItemDraft }) {
  const model = useData((s) => s.model);
  const create = useEditor((s) => s.createAndPlace);
  const [name, setName] = useState(itemType(draft.type)?.defaultName ?? typeLabel(draft.type));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name is the dialog's only field: start there, with the default selected.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const floor = model?.floorById.get(draft.floorId);
  const roomId = floor?.cells.get(cellKey(draft.cell.x, draft.cell.y));
  const room = roomId ? (model?.rooms.get(roomId)?.name ?? null) : null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const dialog = e.currentTarget.closest('dialog');
    const clean = name.trim();
    if (!clean) {
      setError(EDITOR.newItemNameInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await create(draft, clean);
      dialog?.close();
    } catch (err) {
      setError(
        EDITOR.newItemFailed(
          err instanceof ApiError
            ? (err.detail ?? err.message)
            : err instanceof Error
              ? err.message
              : String(err),
        ),
      );
      setBusy(false);
    }
  };

  return (
    <form className="new-item" onSubmit={(e) => void submit(e)}>
      <label className="text">
        {EDITOR.newItemName}
        <input
          value={name}
          maxLength={120}
          ref={input}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </label>
      <p className="muted">{EDITOR.newItemWhere(room, floor?.floor.name ?? draft.floorId)}</p>
      <p className="muted small">{EDITOR.newItemNote}</p>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        <button
          type="button"
          className="btn"
          onClick={(e) => e.currentTarget.closest('dialog')?.close()}
          disabled={busy}
        >
          {EDITOR.newItemCancel}
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? EDITOR.newItemCreating : EDITOR.newItemCreate}
        </button>
      </div>
    </form>
  );
}

export function NewItemDialog() {
  const draft = useEditor((s) => s.draft);
  const setDraft = useEditor((s) => s.setDraft);
  if (!draft) return null;
  return (
    <Dialog
      title={EDITOR.newItemTitle(typeLabel(draft.type))}
      onClose={() => setDraft(null)}
      className="new-item-dialog"
    >
      <Form key={`${draft.type}@${draft.floorId}:${draft.cell.x},${draft.cell.y}`} draft={draft} />
    </Dialog>
  );
}
