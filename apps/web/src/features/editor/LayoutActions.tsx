/**
 * Layout actions in the details panel (edit mode): rotate or remove a placed item from the plan,
 * and for a ghost (a placement whose note is missing, DESIGN 15.2) relink it to an unplaced
 * note or remove the placement. Keyboard-reachable alternatives to the pointer tools.
 */
import { useState } from 'react';
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { useEditor } from '../../store/editor';

export function ItemLayoutActions({ itemId }: { itemId: string }) {
  const mode = useEditor((s) => s.mode);
  const placed = useData((s) => !!s.model?.placements.get(itemId));
  const rotate = useEditor((s) => s.rotateItem);
  const unplace = useEditor((s) => s.unplaceItem);
  if (mode !== 'edit' || !placed) return null;
  return (
    <section className="layout-actions" aria-label={EDITOR.layoutActions}>
      <button
        type="button"
        className="btn"
        title={EDITOR.rotateTitle}
        onClick={() => rotate(itemId)}
      >
        ↻ {EDITOR.rotate}
      </button>
      <button
        type="button"
        className="btn"
        title={EDITOR.unplaceTitle}
        onClick={() => unplace(itemId)}
      >
        {EDITOR.unplace}
      </button>
    </section>
  );
}

export function GhostActions({ ghostId }: { ghostId: string }) {
  const mode = useEditor((s) => s.mode);
  const editor = useData((s) => s.me?.role === 'editor');
  const unplaced = useData((s) => s.model?.unplaced);
  const relink = useEditor((s) => s.relinkGhost);
  const remove = useEditor((s) => s.removeGhost);
  const [target, setTarget] = useState('');
  if (!editor) return null;
  if (mode !== 'edit') return <p className="muted">{EDITOR.ghostEditHint}</p>;
  const candidates = unplaced ?? [];
  return (
    <section className="layout-actions ghost-actions" aria-label={EDITOR.layoutActions}>
      {candidates.length ? (
        <form
          className="relink"
          onSubmit={(e) => {
            e.preventDefault();
            if (target) relink(ghostId, target);
          }}
        >
          <label className="text">
            {EDITOR.ghostRelinkLabel}
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{EDITOR.ghostRelinkChoose}</option>
              {candidates.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={!target}>
            {EDITOR.ghostRelink}
          </button>
        </form>
      ) : (
        <p className="muted small">{EDITOR.ghostNoCandidates}</p>
      )}
      <button type="button" className="btn" onClick={() => remove(ghostId)}>
        {EDITOR.ghostRemove}
      </button>
    </section>
  );
}
