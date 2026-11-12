/**
 * Floor → Room → Item list: the accessible alternative to the plan and the phone-friendly view
 * (DESIGN 15.12). Tab works as usual; ↑/↓, Home and End move between entries.
 */
import type { Item } from '../../api/types';
import { typeLabel } from '../../catalog/catalog';
import { TypeIcon } from '../../catalog/TypeIcon';
import { moveFocus } from '../../components/listNav';
import { LEVEL_TEXT, currentStatus, levelTone } from '../../components/status';
import { formatArea } from '../../domain/plan';
import { STICKERS } from '../../strings/stickers';
import { printPath } from '../print/pages';
import { useData } from '../../store/data';
import { type FloorModel, type Model, itemsInRoom } from '../../store/model';
import { useSearchResults } from '../../store/search';
import { useUi } from '../../store/ui';

function ItemRow({ item, model }: { item: Item; model: Model }) {
  const select = useUi((s) => s.select);
  const selected = useUi((s) => s.selection?.kind === 'item' && s.selection.id === item.id);
  const level = currentStatus(item, model.snapshot).level;
  const sub =
    [item.fields.brand, item.fields.model].filter(Boolean).join(' · ') || typeLabel(item.type);
  return (
    <li>
      <button
        type="button"
        className={`row-btn${selected ? ' sel' : ''}`}
        data-nav
        data-item-id={item.id}
        aria-current={selected || undefined}
        onClick={() => select({ kind: 'item', id: item.id })}
      >
        <TypeIcon type={item.type} />
        <span className="grow">
          {item.name}
          <small>{sub}</small>
        </span>
        {level && <span className={`flag ${levelTone(level)}`}>{LEVEL_TEXT[level]}</span>}
      </button>
    </li>
  );
}

function FloorSection({
  floor,
  model,
  filter,
}: {
  floor: FloorModel;
  model: Model;
  filter: ((i: Item) => boolean) | null;
}) {
  const select = useUi((s) => s.select);
  const rooms = [...floor.roomAreas.keys()]
    .map((id) => model.rooms.get(id)!)
    .sort((a, b) => a.name.localeCompare(b.name));
  const inRooms = new Set<string>();
  const groups = rooms
    .map((room) => {
      const items = itemsInRoom(floor, room.id);
      items.forEach((i) => inRooms.add(i.id));
      return { room, items: filter ? items.filter(filter) : items };
    })
    .filter((g) => !filter || g.items.length > 0);
  const loose = floor.items.filter((i) => !inRooms.has(i.id) && (!filter || filter(i)));
  if (filter && groups.length === 0 && loose.length === 0) return null;
  const headingId = `floor-${floor.floor.id}`;

  return (
    <section className="list-floor" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {floor.floor.name}
        <small>Level {floor.floor.level}</small>
      </h2>
      {groups.map(({ room, items }) => (
        <div key={room.id} className="list-room">
          <h3>
            <button
              type="button"
              className="room-btn"
              data-nav
              data-room-id={room.id}
              onClick={() => select({ kind: 'room', roomId: room.id, floorId: floor.floor.id })}
            >
              <span className="swatch" style={{ background: room.color }} aria-hidden="true" />
              {room.name}
              <small>{formatArea(floor.roomAreas.get(room.id) ?? 0)}</small>
            </button>
          </h3>
          {items.length ? (
            <ul className="list">
              {items.map((i) => (
                <ItemRow key={i.id} item={i} model={model} />
              ))}
            </ul>
          ) : (
            <p className="muted empty-room">Nothing here yet.</p>
          )}
        </div>
      ))}
      {loose.length > 0 && (
        <div className="list-room">
          <h3 className="plain">Not in a room</h3>
          <ul className="list">
            {loose.map((i) => (
              <ItemRow key={i.id} item={i} model={model} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ListView() {
  const model = useData((s) => s.model)!;
  const search = useSearchResults();
  const filter = search.active ? (i: Item) => search.matches.has(i.id) : null;
  const unplaced = filter ? model.unplaced.filter(filter) : model.unplaced;

  return (
    // Arrow keys move between the buttons inside (keydown delegation, not a widget of its own).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section className="stage list-view" aria-label="Items by floor and room" onKeyDown={moveFocus}>
      <div className="attention-tools">
        <a
          className="btn"
          href={printPath(
            'stickers',
            filter ? [...model.items.values()].filter(filter).map((i) => i.id) : undefined,
          )}
        >
          {STICKERS.open}
        </a>
      </div>
      {search.active && (
        <p className="list-summary" role="status">
          {search.ids.length === 0
            ? 'No items match the search.'
            : `${search.ids.length} ${search.ids.length === 1 ? 'item matches' : 'items match'} the search.`}
        </p>
      )}
      {model.snapshot.items.length === 0 && <p className="muted">No items yet.</p>}
      {model.floors.map((f) => (
        <FloorSection key={f.floor.id} floor={f} model={model} filter={filter} />
      ))}
      {unplaced.length > 0 && (
        <section className="list-floor" aria-labelledby="floor-unplaced">
          <h2 id="floor-unplaced">Unplaced</h2>
          <ul className="list">
            {unplaced.map((i) => (
              <ItemRow key={i.id} item={i} model={model} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
