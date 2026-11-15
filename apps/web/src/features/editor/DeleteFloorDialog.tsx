/** "Delete floor" confirmation (D35): lists what goes with it, like the resize dialog. */
import { floorLoss } from '../../commands';
import { Dialog } from '../../components/Dialog';
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { useEditor } from '../../store/editor';

export function DeleteFloorDialog({ floorId, onClose }: { floorId: string; onClose: () => void }) {
  const house = useData((s) => s.model?.snapshot.house);
  const items = useData((s) => s.model?.items);
  const rooms = new Map((house?.rooms ?? []).map((r) => [r.id, r.name]));
  const deleteFloor = useEditor((s) => s.deleteFloor);
  if (!house) return null;
  const loss = floorLoss(house, floorId);
  if (!loss.floor) return null; // deleted meanwhile
  const name = loss.floor.name;

  const tilesByRoom = new Map<string, number>();
  for (const roomId of Object.values(loss.floor.cells ?? {}))
    tilesByRoom.set(roomId, (tilesByRoom.get(roomId) ?? 0) + 1);
  const roomNames = [...tilesByRoom].map(([id, n]) => ({ name: rooms.get(id) ?? id, n }));
  const itemNames = loss.placements
    .map((p) => items?.get(p.placement.itemId)?.name ?? p.placement.itemId)
    .join(', ');
  const empty = loss.tiles === 0 && loss.placements.length === 0 && loss.openings.length === 0;

  return (
    <Dialog title={EDITOR.floorDeleteTitle(name)} onClose={onClose} className="delete-dialog">
      {empty ? (
        <p>{EDITOR.floorDeleteEmpty}</p>
      ) : (
        <>
          <p>{EDITOR.floorDeleteLoses}</p>
          <ul className="delete-what">
            {loss.tiles > 0 && <li>{EDITOR.floorLossTiles(loss.tiles, roomNames)}</li>}
            {loss.placements.length > 0 && <li>{EDITOR.floorLossItems(itemNames)}</li>}
            {loss.openings.length > 0 && (
              <li>{EDITOR.floorLossOpenings(loss.openings.map((o) => o.opening))}</li>
            )}
          </ul>
        </>
      )}
      <p className="muted small">{EDITOR.floorDeleteUndo}</p>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>
          Keep it
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (deleteFloor(floorId)) onClose();
          }}
        >
          {EDITOR.floorDeleteConfirm}
        </button>
      </div>
    </Dialog>
  );
}
