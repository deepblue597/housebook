/**
 * First run (DESIGN 15.16, D34): no house.json yet. Editors create one (one empty floor, a grid
 * of 1 m tiles), and the editor opens with a first room to paint. Notes that already exist wait
 * in the Unplaced tray. An unreadable house.json is never replaced from here: the server marks it
 * read-only, and this screen only offers to create a file that doesn't exist.
 */
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, getJson, putHouse } from '../../api/client';
import { firstLayout, MAX_GRID, MIN_GRID } from '../../domain/layout';
import { useData } from '../../store/data';
import { useEditor } from '../../store/editor';

const DEFAULTS = { name: 'Ground floor', width: '16', depth: '10' };

export function NoFloorPlan() {
  const snapshot = useData((s) => s.model?.snapshot);
  const editor = useData((s) => s.me?.role === 'editor');
  const notes = useData((s) => s.model?.items.size ?? 0);
  const missing = !!snapshot && !snapshot.house && !snapshot.houseReadOnly;

  if (!missing)
    return (
      <section className="stage state">
        <h2>No floor plan yet</h2>
        <p className="muted">
          There is no valid <code>house.json</code> in the data folder. Items are still listed in
          the List view.
        </p>
      </section>
    );
  if (!editor)
    return (
      <section className="stage state">
        <h2>No floor plan yet</h2>
        <p className="muted">
          Nobody has drawn this house yet. Someone who can edit it can set it up.
          {notes > 0 && ' Items are already listed in the List view.'}
        </p>
      </section>
    );
  return <FirstRun notes={notes} />;
}

/** Tagged notes without a `housebook_id` yet (`not_adopted`): typical for an existing vault. */
function useNotAdopted(): number {
  const rev = useData((s) => s.problemsRev);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    getJson('/api/problems').then(
      (r) => live && setN(r.problems.filter((p) => p.kind === 'not_adopted').length),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rev]);
  return n;
}

function FirstRun({ notes }: { notes: number }) {
  const notAdopted = useNotAdopted();
  const [name, setName] = useState(DEFAULTS.name);
  const [width, setWidth] = useState(DEFAULTS.width);
  const [depth, setDepth] = useState(DEFAULTS.depth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = Number(width);
  const d = Number(depth);
  const layout = firstLayout(name, w, d);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!layout) {
      setError(
        `Give the floor a name and a size of ${MIN_GRID} to ${MAX_GRID} metres on each side.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await putHouse(layout, null); // If-None-Match: * (only if there is still no house.json)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 412)) {
        setError(
          err instanceof ApiError
            ? `The floor plan couldn’t be created: ${err.detail ?? err.message}`
            : 'The server couldn’t be reached.',
        );
        setBusy(false);
        return;
      }
      // Someone created it meanwhile: show theirs.
      useEditor.getState().notify('info', 'The floor plan was just created elsewhere.');
    }
    await useData.getState().load();
    useEditor.getState().setMode('edit');
    const rooms = useData.getState().model?.snapshot.house?.rooms ?? [];
    // "Room 1", with the paint tool: drag on the grid to draw it.
    if (useEditor.getState().mode === 'edit' && rooms.length === 0) useEditor.getState().addRoom();
  };

  return (
    <section className="stage state first-run" aria-labelledby="first-run-h">
      <form className="first-run-card" onSubmit={(e) => void create(e)} noValidate>
        <h2 id="first-run-h">Set up your house</h2>
        <p className="muted">
          Start with the outline of one floor. You can add rooms, items, more space and doors next,
          and resize the house any time.
        </p>
        <label>
          Name of this floor
          <input
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="first-run-size">
          <label>
            Width (east–west), m
            <input
              type="number"
              inputMode="numeric"
              min={MIN_GRID}
              max={MAX_GRID}
              step={1}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Depth (north–south), m
            <input
              type="number"
              inputMode="numeric"
              min={MIN_GRID}
              max={MAX_GRID}
              step={1}
              value={depth}
              onChange={(e) => setDepth(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        <p className="muted small">
          {layout
            ? `A grid of ${w} × ${d} tiles of 1 m (${w * d} m²). Leave a little room around the walls.`
            : `Each side: ${MIN_GRID} to ${MAX_GRID} whole metres.`}
        </p>
        {(notes > 0 || notAdopted > 0) && (
          <div className="first-run-notes">
            {notes > 0 && (
              <p>
                {notes === 1 ? '1 item was' : `${notes} items were`} found in your notes. After this
                step, place {notes === 1 ? 'it' : 'them'} on the plan from the Unplaced tray.
              </p>
            )}
            {notAdopted > 0 && (
              <p>
                {notAdopted === 1 ? '1 note is' : `${notAdopted} notes are`} tagged{' '}
                <code>housebook</code> but not part of Housebook yet. Adopt{' '}
                {notAdopted === 1 ? 'it' : 'them'} in the problems list (⚠ at the top), then place{' '}
                {notAdopted === 1 ? 'it' : 'them'} from the Unplaced tray.
              </p>
            )}
          </div>
        )}
        <p className="msg err" role="status">
          {error ?? ''}
        </p>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create the floor plan'}
        </button>
      </form>
    </section>
  );
}
