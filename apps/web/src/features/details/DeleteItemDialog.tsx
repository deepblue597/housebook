/** "Delete item" confirmation (D32): says what goes where, and that it can be recovered. */
import { useState } from 'react';
import type { Item } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { useData } from '../../store/data';
import { useEditor } from '../../store/editor';
import { useUi } from '../../store/ui';
import { DeleteError, deleteItem } from './deleteItem';

export function DeleteItemDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placed = useData(
    (s) => !!s.model?.snapshot.house?.placements?.some((p) => p.itemId === item.id),
  );
  // The server also moves the folder named like the note next to it (data contract §8.2).
  const folder = `${item.path.replace(/\.md$/i, '')}/`;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteItem(item.id);
      useUi.getState().select(null);
      useEditor
        .getState()
        .notify(
          'info',
          `“${item.name}” was deleted. Its note is in the data folder’s trash (.housebook/trash/) for 90 days.`,
        );
    } catch (e) {
      setError(e instanceof DeleteError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Delete “${item.name}”?`} onClose={onClose} className="delete-dialog">
      <ul className="delete-what">
        {placed && <li>It is taken off the plan.</li>}
        <li>
          Its note <code>{item.path}</code> and, if there is one, the attachments folder{' '}
          <code>{folder}</code> move to the trash in the data folder (<code>.housebook/trash/</code>
          ), where they are kept for 90 days. To restore, move them back.
        </li>
      </ul>
      <p className="msg err" role="status">
        {error ?? ''}
      </p>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Keep it
        </button>
        <button type="button" className="btn danger" onClick={() => void confirm()} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Dialog>
  );
}
