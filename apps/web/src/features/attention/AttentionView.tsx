/**
 * What needs attention (goal G5, milestone 8, D38): overdue checks, then checks due within
 * 30 days and warranties ending within 60, by date. Each entry opens its item. Follows the
 * search like the List view. Arrow keys move between entries.
 */
import { useState } from 'react';
import type { Item } from '../../api/types';
import { TypeIcon } from '../../catalog/TypeIcon';
import { moveFocus } from '../../components/listNav';
import { currentStatus } from '../../components/status';
import { formatDate } from '../../domain/dates';
import { DUE_SOON_DAYS, WARRANTY_ENDING_DAYS } from '../../domain/status';
import { useData } from '../../store/data';
import { type Model, floorOf, roomOf } from '../../store/model';
import { useSearchResults } from '../../store/search';
import { useUi } from '../../store/ui';
import { CalendarDialog } from './CalendarDialog';
import { type AttentionEntry, attentionEntries, entryText } from './entries';

/** Where the item is: "Kitchen · Ground floor", or "Unplaced". */
function where(model: Model, item: Item): string {
  const floor = floorOf(model, item);
  if (!floor) return 'Unplaced';
  const room = roomOf(model, item);
  return room ? `${room.name} · ${floor.floor.name}` : floor.floor.name;
}

function EntryRow({ entry, model }: { entry: AttentionEntry; model: Model }) {
  const select = useUi((s) => s.select);
  const selected = useUi((s) => s.selection?.kind === 'item' && s.selection.id === entry.item.id);
  const tone = entry.kind === 'check_overdue' ? 'bad' : 'warn';
  const when =
    entry.kind === 'warranty_ending'
      ? `Warranty until ${formatDate(entry.date)}`
      : `${entry.kind === 'check_overdue' ? 'Was due' : 'Due'} ${formatDate(entry.date)}${
          entry.derived ? ` (every ${entry.item.fields.check_every})` : ''
        }`;
  return (
    <li>
      <button
        type="button"
        className={`row-btn${selected ? ' sel' : ''}`}
        data-nav
        data-item-id={entry.item.id}
        data-kind={entry.kind}
        aria-current={selected || undefined}
        onClick={() => select({ kind: 'item', id: entry.item.id })}
      >
        <TypeIcon type={entry.item.type} />
        <span className="grow">
          {entry.item.name}
          <small>{where(model, entry.item)}</small>
        </span>
        <span className="attention-when">
          <span className={`flag ${tone}`}>{entryText(entry)}</span>
          <small>{when}</small>
        </span>
      </button>
    </li>
  );
}

function Group({
  id,
  title,
  note,
  entries,
  model,
}: {
  id: string;
  title: string;
  note: string;
  entries: AttentionEntry[];
  model: Model;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="list-floor" aria-labelledby={id}>
      <h2 id={id}>
        {title}
        <small>{note}</small>
      </h2>
      <ul className="list">
        {entries.map((e) => (
          <EntryRow key={e.key} entry={e} model={model} />
        ))}
      </ul>
    </section>
  );
}

export function AttentionView() {
  const model = useData((s) => s.model)!;
  const search = useSearchResults();
  const items = search.active
    ? model.snapshot.items.filter((i) => search.matches.has(i.id))
    : model.snapshot.items;
  const { overdue, upcoming } = attentionEntries(items, (i) => currentStatus(i, model.snapshot));
  const none = overdue.length === 0 && upcoming.length === 0;
  const [calendar, setCalendar] = useState(false);

  return (
    // Arrow keys move between the buttons inside (keydown delegation, not a widget of its own).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      className="stage list-view attention-view"
      aria-label="What needs attention"
      onKeyDown={moveFocus}
    >
      <div className="attention-tools">
        <button type="button" className="btn" onClick={() => setCalendar(true)}>
          Add to your calendar
        </button>
      </div>
      {calendar && <CalendarDialog onClose={() => setCalendar(false)} />}
      {search.active && (
        <p className="list-summary" role="status">
          Showing only items that match the search.
        </p>
      )}
      {none ? (
        <div className="attention-empty">
          <p>
            <b>Nothing needs attention{search.active ? ' among the matching items' : ''}.</b>
          </p>
          <p className="muted">
            Checks due in the next {DUE_SOON_DAYS} days and warranties ending in the next{' '}
            {WARRANTY_ENDING_DAYS} days show up here. Set a next check or a check interval in an
            item’s note to have it remind you.
          </p>
        </div>
      ) : (
        <>
          <Group
            id="attention-overdue"
            title="Overdue"
            note="longest overdue first"
            entries={overdue}
            model={model}
          />
          <Group
            id="attention-upcoming"
            title="Coming up"
            note={`checks in ${DUE_SOON_DAYS} days, warranties in ${WARRANTY_ENDING_DAYS}`}
            entries={upcoming}
            model={model}
          />
        </>
      )}
    </section>
  );
}
