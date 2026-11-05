/**
 * Search box with a results dropdown (ARIA combobox). Matching items are highlighted on the
 * plan and counted per floor; picking a result opens it.
 */
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { typeLabel } from '../../catalog/catalog';
import { TypeIcon } from '../../catalog/TypeIcon';
import { useData } from '../../store/data';
import { roomOf } from '../../store/model';
import { useSearchResults } from '../../store/search';
import { useUi } from '../../store/ui';

const MAX_RESULTS = 8;

export function SearchBox() {
  const model = useData((s) => s.model);
  const query = useUi((s) => s.query);
  const setQuery = useUi((s) => s.setQuery);
  const select = useUi((s) => s.select);
  const { ids, active } = useSearchResults();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);

  const shown = ids.slice(0, MAX_RESULTS);
  const expanded = open && active;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // Keep the active option visible while arrowing through a list taller than its box.
  useEffect(() => {
    if (!expanded) return;
    list.current?.children[cursor]?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, expanded]);

  const choose = (id: string) => {
    select({ kind: 'item', id });
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      const n = shown.length;
      if (n) setCursor((c) => (e.key === 'ArrowDown' ? (c + 1) % n : (c - 1 + n) % n));
    } else if (e.key === 'Enter') {
      const id = shown[cursor] ?? shown[0];
      if (id) {
        e.preventDefault();
        choose(id);
      }
    } else if (e.key === 'Escape') {
      // First Esc closes the dropdown, the second clears the query; never close the panel too.
      // preventDefault also stops type="search" from clearing itself on the first Esc.
      e.preventDefault();
      e.stopPropagation();
      if (expanded) setOpen(false);
      else setQuery('');
    }
  };

  return (
    <div className="search" role="search">
      <input
        type="search"
        role="combobox"
        aria-label="Search items, models, error codes"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && shown[cursor] ? optionId(cursor) : undefined}
        placeholder="Search items, models, error codes"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <div className="results" hidden={!expanded}>
        {/* The list is the scroll container; it is focusable (tabindex -1) so the scrollable
            region is keyboard-operable, while focus normally stays in the input. */}
        <ul ref={list} id={listId} role="listbox" aria-label="Search results" tabIndex={-1}>
          {model &&
            shown.map((id, i) => {
              const item = model.items.get(id)!;
              const floor = item.location ? model.floorById.get(item.location.floorId) : undefined;
              const where = [
                roomOf(model, item)?.name ?? 'No room',
                floor?.floor.name ?? 'Unplaced',
              ];
              return (
                <li
                  key={id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === cursor}
                  className={i === cursor ? 'active' : undefined}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(id);
                  }}
                >
                  <TypeIcon type={item.type} />
                  <span>
                    {item.name}
                    <small>
                      {[...where, item.fields.model || typeLabel(item.type)].join(' · ')}
                    </small>
                  </span>
                </li>
              );
            })}
        </ul>
        {active && ids.length === 0 && (
          <p className="none">{`Nothing matches “${query.trim()}”.`}</p>
        )}
        {ids.length > MAX_RESULTS && (
          <p className="none">{`${ids.length - MAX_RESULTS} more highlighted on the plan.`}</p>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {active ? `${ids.length} ${ids.length === 1 ? 'result' : 'results'}` : ''}
      </span>
    </div>
  );
}
