/**
 * Side panel (bottom sheet on phones) for the selected item or room. Focus moves to the title
 * on open and back to the item on the plan or list on close; Esc closes (DESIGN 15.12).
 */
import { useCallback, useEffect, useRef } from 'react';
import { useData } from '../../store/data';
import { GhostActions } from '../editor';
import { useUi } from '../../store/ui';
import { ItemDetails } from './ItemDetails';
import { RoomDetails } from './RoomDetails';

export function DetailsPanel() {
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const model = useData((s) => s.model);
  const state = useData((s) => s.state);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  const key = selection ? (selection.kind === 'item' ? selection.id : selection.roomId) : null;

  const close = useCallback(() => {
    const prev = useUi.getState().selection;
    select(null);
    // Return focus to the thing that represents the selection, else to whatever opened the panel.
    requestAnimationFrame(() => {
      const id = prev?.kind === 'item' ? prev.id : prev?.kind === 'room' ? prev.roomId : null;
      const sel = id && CSS.escape(id);
      const query =
        prev?.kind === 'item'
          ? `[data-item-id="${sel}"], [data-ghost-id="${sel}"]`
          : `[data-room-id="${sel}"]`;
      const target =
        (id && document.querySelector<HTMLElement>(query)) ||
        (opener.current instanceof HTMLElement && opener.current.isConnected
          ? opener.current
          : null);
      target?.focus();
    });
  }, [select]);

  // Move focus into the panel when a different item or room is opened (or when its data first
  // arrives for a deep link), never on a background refresh of the same selection.
  const ready = model !== null;
  useEffect(() => {
    if (!key || !ready) return;
    if (!document.activeElement?.closest('.panel')) opener.current = document.activeElement;
    heading.current?.focus({ preventScroll: true });
  }, [key, ready]);

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('dialog')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selection, close]);

  if (!selection) return null;

  let content;
  if (!model) {
    content = (
      <p className="muted">{state === 'error' ? 'Couldn’t load the house.' : 'Loading…'}</p>
    );
  } else if (selection.kind === 'item') {
    const item = model.items.get(selection.id);
    const ghost = item ? undefined : model.placements.get(selection.id);
    const ghostFloor = ghost ? model.floorById.get(ghost.floorId) : undefined;
    const ghostRoomId = ghost ? ghostFloor?.cells.get(`${ghost.x},${ghost.y}`) : undefined;
    const ghostRoom = ghostRoomId ? model.rooms.get(ghostRoomId) : undefined;
    content = item ? (
      <ItemDetails item={item} model={model} headingRef={heading} onClose={close} />
    ) : (
      <div className="details">
        <header className="p-head">
          <div className="grow">
            {ghost && (
              <p className="eyebrow">
                {ghostRoom?.name ?? 'No room'} · {ghostFloor?.floor.name ?? 'Unknown floor'}
              </p>
            )}
            <h2 ref={heading} tabIndex={-1}>
              {ghost ? 'Note missing' : 'Item not found'}
            </h2>
          </div>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close details">
            ✕
          </button>
        </header>
        {ghost ? (
          <>
            <p className="muted">
              The layout places <code>{selection.id}</code> here, but no note has that{' '}
              <code>housebook_id</code>. It may have been deleted or renamed outside Housebook, or
              its <code>housebook_id</code> was changed.
            </p>
            <GhostActions ghostId={selection.id} />
          </>
        ) : (
          <p className="muted">
            No item with id <code>{selection.id}</code>. It may have been deleted, or its note lost
            its <code>housebook_id</code>.
          </p>
        )}
      </div>
    );
  } else {
    const floor = model.floorById.get(selection.floorId);
    content = floor ? (
      <RoomDetails
        roomId={selection.roomId}
        floor={floor}
        model={model}
        headingRef={heading}
        onClose={close}
      />
    ) : null;
  }

  return (
    <aside className="panel" aria-label="Details">
      {content}
    </aside>
  );
}
