import type { Ref } from 'react';
import { typeLabel } from '../../catalog/catalog';
import { TypeIcon } from '../../catalog/TypeIcon';
import { LEVEL_TEXT, currentStatus, levelTone } from '../../components/status';
import { formatArea } from '../../domain/plan';
import { type FloorModel, type Model, itemsInRoom } from '../../store/model';
import { useUi } from '../../store/ui';

interface Props {
  roomId: string;
  floor: FloorModel;
  model: Model;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
}

export function RoomDetails({ roomId, floor, model, headingRef, onClose }: Props) {
  const select = useUi((s) => s.select);
  const room = model.rooms.get(roomId);
  if (!room) return null;
  const items = itemsInRoom(floor, roomId);

  return (
    <article className="details" aria-labelledby="details-title">
      <header className="p-head">
        <div className="p-icon swatch" style={{ background: room.color }} aria-hidden="true" />
        <div className="grow">
          <p className="eyebrow">
            Room · {formatArea(floor.roomAreas.get(roomId) ?? 0)} · {floor.floor.name}
          </p>
          <h2 id="details-title" ref={headingRef} tabIndex={-1}>
            {room.name}
          </h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>
      {items.length ? (
        <ul className="list">
          {items.map((it) => {
            const level = currentStatus(it, model.snapshot).level;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  className="row-btn"
                  onClick={() => select({ kind: 'item', id: it.id })}
                >
                  <TypeIcon type={it.type} />
                  <span className="grow">
                    {it.name}
                    <small>
                      {[it.fields.brand, it.fields.model].filter(Boolean).join(' · ') ||
                        typeLabel(it.type)}
                    </small>
                  </span>
                  {level && <span className={`flag ${levelTone(level)}`}>{LEVEL_TEXT[level]}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">Nothing in this room yet.</p>
      )}
    </article>
  );
}
