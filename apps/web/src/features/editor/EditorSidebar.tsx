/**
 * Edit mode's side bar (DESIGN §7.6): tool rail with undo/redo, resize and the save state; the
 * room list (create, rename, recolour, paint with, delete when unused); the catalogue palette;
 * the Unplaced tray (DESIGN 15.2). Every change goes through the editor store's commands.
 */
import { type KeyboardEvent, useMemo, useState } from 'react';
import { itemTypes, typeLabel } from '../../catalog/catalog';
import { repairFixes } from '../../commands';
import { layoutIssues } from '../../domain/layout';
import { TypeIcon } from '../../catalog/TypeIcon';
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { type Tool, applyContext, useEditor } from '../../store/editor';
import { useUi } from '../../store/ui';
import { TRAY_MIME } from './useToolPointer';

const TOOLS: Exclude<Tool, 'place'>[] = ['select', 'paint', 'erase'];

const TOOL_ICON: Record<Exclude<Tool, 'place'>, string> = {
  select: 'M5 3l12 9-5 1 3 6-2 1-3-6-4 4z',
  paint: 'M4 20c3 0 4-2 4-4l9-9-3-3-9 9c-2 0-4 1-4 4zM13 5l3 3',
  erase: 'M4 16l9-9 6 6-7 7H7zM10 20h10M9 11l5 5',
};

function SaveStatus() {
  const save = useEditor((s) => s.save);
  const error = useEditor((s) => s.saveError);
  const fatal = useEditor((s) => s.saveFatal);
  const saveNow = useEditor((s) => s.saveNow);
  const discard = useEditor((s) => s.discard);
  const text =
    save === 'saved'
      ? EDITOR.save.saved
      : save === 'saving'
        ? EDITOR.save.saving
        : save === 'pending'
          ? EDITOR.save.pending
          : EDITOR.save.error;
  return (
    <div className={`save-state ${save}`} data-save={save}>
      <p role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {text}
      </p>
      {save === 'error' && (
        <>
          {error && (
            <p className="save-error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            {!fatal && (
              <button type="button" className="btn" onClick={() => void saveNow()}>
                {EDITOR.save.retry}
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (window.confirm(EDITOR.save.discardConfirm)) discard();
              }}
            >
              {EDITOR.save.discard}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ToolRail({ onResize }: { onResize: () => void }) {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const undoTop = useEditor((s) => s.undo.at(-1)?.label ?? null);
  const redoTop = useEditor((s) => s.redo.at(-1)?.label ?? null);
  const undo = useEditor((s) => s.undoLast);
  const redo = useEditor((s) => s.redoLast);
  return (
    <div
      className="rail"
      role="toolbar"
      aria-label={EDITOR.railLabel}
      aria-orientation="horizontal"
    >
      {TOOLS.map((t) => (
        <button
          key={t}
          type="button"
          className={`tool${tool === t ? ' on' : ''}`}
          aria-pressed={tool === t}
          data-tool={t}
          title={`${EDITOR.tools[t].label} (${EDITOR.tools[t].key})`}
          onClick={() => setTool(t)}
        >
          <svg className="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d={TOOL_ICON[t]} />
          </svg>
          <span>{EDITOR.tools[t].label}</span>
        </button>
      ))}
      <span className="sep" aria-hidden="true" />
      <button
        type="button"
        className="tool"
        onClick={undo}
        disabled={!undoTop}
        title={EDITOR.undoTitle(undoTop)}
        aria-label={undoTop ? EDITOR.undoTitle(undoTop) : EDITOR.undo}
      >
        <svg className="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12" />
        </svg>
        <span>{EDITOR.undo}</span>
      </button>
      <button
        type="button"
        className="tool"
        onClick={redo}
        disabled={!redoTop}
        title={EDITOR.redoTitle(redoTop)}
        aria-label={redoTop ? EDITOR.redoTitle(redoTop) : EDITOR.redo}
      >
        <svg className="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12" />
        </svg>
        <span>{EDITOR.redo}</span>
      </button>
      <button type="button" className="tool wide" onClick={onResize}>
        {EDITOR.resize}
      </button>
    </div>
  );
}

/**
 * Problems in the editor's own layout that it can fix (D30): from hand edits or other tools,
 * never from the editor. Each button is one undoable edit; an issue disappears once fixed.
 */
function Repairs() {
  const model = useData((s) => s.model);
  const repair = useEditor((s) => s.repair);
  const issues = useMemo(
    () =>
      model?.snapshot.house ? layoutIssues(model.snapshot.house, applyContext().footprintOf) : [],
    [model],
  );
  if (!issues.length || !model) return null;
  const name = (id: string) => model.items.get(id)?.name ?? id;
  return (
    <section className="ed-section repairs" aria-labelledby="ed-repairs">
      <header>
        <h3 id="ed-repairs">{EDITOR.repair.title}</h3>
      </header>
      <p className="muted small">{EDITOR.repair.intro}</p>
      <ul>
        {issues.map((issue, i) => (
          <li key={`${issue.kind}:${i}`} data-issue={issue.kind}>
            <p>{EDITOR.repair.describe(issue, name)}</p>
            <div className="row">
              {repairFixes(issue).map((fix) => (
                <button key={fix} type="button" className="btn" onClick={() => repair(issue, fix)}>
                  {EDITOR.repair.button(issue, fix)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolHint() {
  const tool = useEditor((s) => s.tool);
  const place = useEditor((s) => s.place);
  const paintRoomId = useEditor((s) => s.paintRoomId);
  const rooms = useData((s) => s.model?.rooms);
  const items = useData((s) => s.model?.items);
  let text: string;
  if (tool === 'paint') {
    const room = paintRoomId ? rooms?.get(paintRoomId)?.name : null;
    text = room ? EDITOR.toolHint.paint(room) : EDITOR.toolHint.paintNoRoom;
  } else if (tool === 'erase') text = EDITOR.toolHint.erase;
  else if (tool === 'place' && place)
    text =
      place.kind === 'type'
        ? EDITOR.toolHint.placeType(typeLabel(place.type))
        : EDITOR.toolHint.placeItem(items?.get(place.itemId)?.name ?? place.itemId);
  else text = EDITOR.toolHint.select;
  return (
    <p className="hint" aria-live="polite">
      {text} {tool !== 'select' && EDITOR.toolHint.cancel}
    </p>
  );
}

function RoomName({ id, name }: { id: string; name: string }) {
  const rename = useEditor((s) => s.renameRoom);
  const [draft, setDraft] = useState(name);
  const commit = () => {
    if (draft === name) return;
    if (!rename(id, draft)) setDraft(name);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(name);
    }
  };
  return (
    <input
      className="room-name"
      value={draft}
      maxLength={100}
      aria-label={EDITOR.roomName(name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

function RoomList() {
  const house = useData((s) => s.model?.snapshot.house);
  const tool = useEditor((s) => s.tool);
  const paintRoomId = useEditor((s) => s.paintRoomId);
  const setPaintRoom = useEditor((s) => s.setPaintRoom);
  const recolor = useEditor((s) => s.recolorRoom);
  const addRoom = useEditor((s) => s.addRoom);
  const deleteRoom = useEditor((s) => s.deleteRoom);
  const tiles = useMemo(() => {
    const n = new Map<string, number>();
    for (const f of house?.floors ?? [])
      for (const id of Object.values(f.cells ?? {})) n.set(id, (n.get(id) ?? 0) + 1);
    return n;
  }, [house]);
  const rooms = house?.rooms ?? [];
  return (
    <section className="ed-section" aria-labelledby="ed-rooms">
      <header>
        <h3 id="ed-rooms">{EDITOR.rooms}</h3>
        <button type="button" className="btn" onClick={() => addRoom()}>
          + {EDITOR.roomAdd}
        </button>
      </header>
      {rooms.length === 0 ? (
        <p className="muted">{EDITOR.noRooms}</p>
      ) : (
        <ul className="rooms">
          {rooms.map((r) => {
            const n = tiles.get(r.id) ?? 0;
            const painting = tool === 'paint' && paintRoomId === r.id;
            return (
              <li key={r.id} className={painting ? 'on' : undefined} data-room={r.id}>
                <input
                  type="color"
                  value={r.color.toLowerCase()}
                  aria-label={EDITOR.roomColor(r.name)}
                  onChange={(e) => recolor(r.id, e.target.value)}
                />
                <RoomName key={`${r.id}:${r.name}`} id={r.id} name={r.name} />
                <span className="count">{EDITOR.roomTiles(n)}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-pressed={painting}
                  aria-label={EDITOR.roomPaint(r.name)}
                  title={EDITOR.roomPaint(r.name)}
                  onClick={() => setPaintRoom(r.id)}
                >
                  <svg
                    className="ico"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    aria-hidden="true"
                  >
                    <path d={TOOL_ICON.paint} />
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={EDITOR.roomDelete(r.name)}
                  title={n > 0 ? EDITOR.roomDeleteDisabled : EDITOR.roomDelete(r.name)}
                  disabled={n > 0}
                  onClick={() => deleteRoom(r.id)}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Catalogue() {
  const place = useEditor((s) => s.place);
  const armPlace = useEditor((s) => s.armPlace);
  return (
    <section className="ed-section" aria-labelledby="ed-cat">
      <header>
        <h3 id="ed-cat">{EDITOR.catalogue}</h3>
      </header>
      <p className="muted small">{EDITOR.catalogueHint}</p>
      <ul className="catalogue">
        {itemTypes().map((t) => {
          const on = place?.kind === 'type' && place.type === t.key;
          return (
            <li key={t.key}>
              <button
                type="button"
                className={on ? 'on' : undefined}
                aria-pressed={on}
                aria-label={EDITOR.addType(t.label)}
                title={EDITOR.addType(t.label)}
                data-type={t.key}
                onClick={() => armPlace({ kind: 'type', type: t.key })}
              >
                <TypeIcon type={t.key} />
                <span>{t.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function UnplacedTray() {
  const unplaced = useData((s) => s.model?.unplaced);
  const place = useEditor((s) => s.place);
  const armPlace = useEditor((s) => s.armPlace);
  const select = useUi((s) => s.select);
  const list = unplaced ?? [];
  return (
    <section className="ed-section" aria-labelledby="ed-tray">
      <header>
        <h3 id="ed-tray">
          {EDITOR.unplaced} <span className="count">{list.length}</span>
        </h3>
      </header>
      {list.length === 0 ? (
        <p className="muted small">{EDITOR.unplacedEmpty}</p>
      ) : (
        <>
          <p className="muted small">{EDITOR.unplacedHint}</p>
          <ul className="tray">
            {list.map((item) => {
              const on = place?.kind === 'item' && place.itemId === item.id;
              return (
                <li
                  key={item.id}
                  draggable
                  data-unplaced-id={item.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TRAY_MIME, item.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <button
                    type="button"
                    className={on ? 'on' : undefined}
                    aria-pressed={on}
                    aria-label={EDITOR.placeThis(item.name)}
                    onClick={() => {
                      armPlace({ kind: 'item', itemId: item.id });
                      select({ kind: 'item', id: item.id });
                    }}
                  >
                    <TypeIcon type={item.type ?? null} />
                    <span>{item.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export function EditorSidebar({ onResize }: { onResize: () => void }) {
  const mode = useEditor((s) => s.mode);
  if (mode !== 'edit') return null;
  return (
    <aside className="editor" aria-label={EDITOR.sidebarLabel}>
      <ToolRail onResize={onResize} />
      <SaveStatus />
      <Repairs />
      <ToolHint />
      <RoomList />
      <Catalogue />
      <UnplacedTray />
      <p className="muted small">{EDITOR.shortcuts}</p>
    </aside>
  );
}
