/** "Edit" in the top bar: editors only, and only for a writable layout (DESIGN §7.6). */
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { useEditor } from '../../store/editor';

export function EditToggle() {
  const role = useData((s) => s.me?.role);
  const hasHouse = useData((s) => !!s.model?.snapshot.house);
  const readOnly = useData((s) => !!s.model?.snapshot.houseReadOnly);
  const mode = useEditor((s) => s.mode);
  const setMode = useEditor((s) => s.setMode);
  if (role !== 'editor' || !hasHouse) return null;
  const on = mode === 'edit';
  return (
    <button
      type="button"
      className={`ghost edit-toggle${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-disabled={readOnly && !on ? true : undefined}
      title={
        readOnly ? EDITOR.editUnavailableReadOnly : on ? EDITOR.editOnTitle : EDITOR.editToggleTitle
      }
      onClick={() => {
        if (readOnly && !on) return;
        setMode(on ? 'view' : 'edit');
      }}
    >
      <svg className="ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
      </svg>
      {EDITOR.editToggle}
    </button>
  );
}
