/**
 * The layout editor (milestone 5, DESIGN §7.3, 15.2): edit mode, the active tool, undo/redo,
 * debounced saving with `If-Match`, and replay of unsaved edits when the server's layout moved.
 *
 * - Every edit is a command (`commands/`). Applying one gives the new layout and its inverse;
 *   the history keeps both, so undo applies the inverse and redo the command again.
 * - Commands applied locally but not yet saved are `pending`, on top of `base` (the server's
 *   layout, ETag `baseEtag`). The data store always shows base + pending (`showLayout`).
 * - Saving is debounced (`SAVE_DELAY_MS` after the last edit) and runs in the data store's
 *   queue (`runExclusive`), so a `house.changed` event is looked at only after the save's
 *   response is in: the event for our own write then carries the held ETag and is ignored.
 * - **412**: fetch the layout, replay the pending commands on it, retry. A command that no longer
 *   applies is dropped and the user is told which one and why; nothing is lost silently.
 * - A layout arriving from the server while edits are pending (SSE `house.changed`, a snapshot
 *   reload) goes through the same replay (`setHouseInterceptor`), then the save goes ahead.
 */
import { type StoreApi, type UseBoundStore, create } from 'zustand';
import { ApiError, fetchHouse, putHouse, sameEtag } from '../api/client';
import type { House, Item } from '../api/types';
import { placementSpec } from '../catalog/catalog';
import {
  type Applied,
  type ApplyContext,
  type Command,
  type Conflict,
  type RepairFix,
  applyCommand,
  floorLoss,
  repairCommand,
  replay,
  shiftCommand,
} from '../commands';
import { type Cell, cellKey } from '../domain/coords';
import {
  type Edge,
  type Layout,
  type LayoutIssue,
  type LayoutPlacement,
  type ResizeDeltas,
  addsProblems,
  canonicalLayout,
  inferShift,
  isWallEdge,
  cleanRoomName,
  isRoomColor,
  isValidId,
  movedPlacement,
  newFloorId,
  newRoomId,
  rectBetween,
  rectCells,
  roomFloors,
  resizedSize,
  rotatedPlacement,
} from '../domain/layout';
import { EDITOR } from '../strings/editor';
import { runExclusive, setHouseInterceptor, useData } from './data';
import { useUi } from './ui';

export const SAVE_DELAY_MS = 1000;
const MAX_HISTORY = 200;
const MAX_SAVE_ATTEMPTS = 5;
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];

export type Tool = 'select' | 'paint' | 'erase' | 'place' | 'door' | 'window';
/** What the place tool puts down: a new note of a catalogue type, or an unplaced item. */
export type PlaceSource = { kind: 'type'; type: string } | { kind: 'item'; itemId: string };
export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** A tool gesture in progress, drawn as a preview by both views. */
export type Gesture =
  | { kind: 'rect'; erase: boolean; floorId: string; from: Cell; to: Cell }
  | { kind: 'move'; itemId: string; floorId: string; from: Cell; to: Cell }
  | { kind: 'place'; floorId: string; cell: Cell }
  | { kind: 'edge'; floorId: string; edge: Edge; opening: 'door' | 'window' };

export interface Notice {
  id: number;
  tone: 'info' | 'warn' | 'error';
  text: string;
}

export interface HistoryEntry {
  id: number;
  label: string;
  cmd: Command;
  inverse: Command;
}

/** A tile picked for a new note of a catalogue type (the name dialog is open). */
export interface NewItemDraft {
  type: string;
  floorId: string;
  cell: Cell;
}

interface EditorState {
  mode: 'view' | 'edit';
  tool: Tool;
  paintRoomId: string | null;
  place: PlaceSource | null;
  gesture: Gesture | null;
  /** Where the active tool would act: a tile, and for doors/windows the nearest edge (D36). */
  hover: { floorId: string; cell: Cell; edge?: Edge | null } | null;
  draft: NewItemDraft | null;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  pending: Applied[];
  base: House | null;
  baseEtag: string | null;
  save: SaveState;
  saveError: string | null;
  /** The last save failure can't be fixed by retrying (422, 409, 403). */
  saveFatal: boolean;
  notices: Notice[];

  setMode: (mode: 'view' | 'edit') => void;
  setTool: (tool: Tool) => void;
  setPaintRoom: (roomId: string) => void;
  armPlace: (source: PlaceSource) => void;
  /** Esc: drop the gesture, then the armed item/type. */
  cancel: () => void;
  setGesture: (g: Gesture | null) => void;
  setHover: (h: EditorState['hover']) => void;
  setDraft: (d: NewItemDraft | null) => void;

  run: (cmd: Command, label: string) => boolean;
  undoLast: () => void;
  redoLast: () => void;

  // Edits (each one command, one undo step).
  paintRect: (floorId: string, from: Cell, to: Cell, erase: boolean) => void;
  moveItem: (itemId: string, dx: number, dy: number) => void;
  rotateItem: (itemId: string) => void;
  unplaceItem: (itemId: string) => void;
  /** Put an unplaced item (or the armed source) on a tile. */
  placeAt: (floorId: string, cell: Cell) => void;
  placeItemAt: (itemId: string, floorId: string, cell: Cell) => boolean;
  /** Create the note (POST /api/items) and then place it (D8 order). */
  createAndPlace: (draft: NewItemDraft, name: string) => Promise<Item>;
  relinkGhost: (ghostId: string, itemId: string) => void;
  removeGhost: (ghostId: string) => void;
  addRoom: () => string | null;
  renameRoom: (roomId: string, name: string) => boolean;
  recolorRoom: (roomId: string, color: string) => void;
  /** Floor and/or wall finish of a room (D41); null removes it. One undo step. */
  setRoomFinish: (roomId: string, change: { floor?: string | null; walls?: string | null }) => void;
  /** Give other rooms this room's floor and wall finish, as one undo step. */
  copyFinish: (fromId: string, toIds: readonly string[]) => void;
  /** Colour of the outside walls (D41); null: the default. */
  setExteriorWallColor: (color: string | null) => void;
  deleteRoom: (roomId: string) => void;
  /** Doors/windows (D36): add `kind` on a wall edge, swap the other kind, or remove the same. */
  toggleOpening: (floorId: string, edge: Edge, kind: 'door' | 'window') => boolean;
  /** A new empty floor above the top one or below the lowest (D35); shows it. Its id. */
  addFloor: (where: 'above' | 'below') => string | null;
  renameFloor: (floorId: string, name: string) => boolean;
  /** Swap levels with the floor above (`up`) or below. */
  moveFloor: (floorId: string, dir: 'up' | 'down') => void;
  /** Remove a floor and what is on it, exactly as `floorLoss` shows it now. */
  deleteFloor: (floorId: string) => boolean;
  resize: (by: ResizeDeltas, allowLoss: string[]) => boolean;
  /** Fix a problem in the layout (D30) as one undoable edit. */
  repair: (issue: LayoutIssue, fix: RepairFix) => boolean;

  saveNow: () => Promise<void>;
  discard: () => void;
  notify: (tone: Notice['tone'], text: string) => void;
  dismiss: (id: number) => void;
}

const ROOM_COLORS = [
  '#E3A94B',
  '#7FB3D5',
  '#A3C586',
  '#D98C8C',
  '#B39DDB',
  '#80CBC4',
  '#F0B27A',
  '#C5B358',
  '#90A4AE',
  '#F48FB1',
];

/** The first palette colour no room uses yet (new and recovered rooms). */
function nextRoomColor(rooms: readonly { color: string }[]): string {
  const used = new Set(rooms.map((r) => r.color.toUpperCase()));
  return ROOM_COLORS.find((c) => !used.has(c)) ?? ROOM_COLORS[rooms.length % ROOM_COLORS.length]!;
}

let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let again = false;
let failures = 0;
/**
 * A save whose outcome is unknown (the request failed on the network: the server may have
 * written it). If the server's layout later turns out to be exactly this body, it was saved:
 * its first `n` pending commands are done (M5-01).
 */
let unconfirmed: { body: string; n: number } | null = null;

const house = (): House | null => useData.getState().model?.snapshot.house ?? null;
const itemName = (id: string) => useData.getState().model?.items.get(id)?.name ?? id;
const floorName = (id: string): string =>
  (house()?.floors ?? []).find((f) => f.id === id)?.name ?? id;

/** Floors by level, highest first (as the floor tabs show them). */
const floorsByLevel = () => [...(house()?.floors ?? [])].sort((a, b) => b.level - a.level);

/** Levels the contract allows (`floors[].level`). */
const MIN_LEVEL = -20;
const MAX_LEVEL = 200;

const roomName = (id: string): string => {
  const find = (h: House | null) => (h?.rooms ?? []).find((r) => r.id === id)?.name;
  return find(house()) ?? find(useEditor.getState().base) ?? id;
};

/** Catalogue footprints for items, 1×1 for ids without a note (ghosts). */
/** Items whose note this app deleted (D32): never placed again, not even by an undo. */
const deletedNotes = new Set<string>();
export const markNoteDeleted = (itemId: string): void => void deletedNotes.add(itemId);

export function applyContext(): ApplyContext {
  const items = useData.getState().model?.items;
  return {
    footprintOf: (id) => placementSpec(items?.get(id)?.type).footprint,
    noteDeleted: (id) => deletedNotes.has(id),
  };
}

/** Readable reason for a conflict, with room/item names instead of ids. */
export function conflictText(c: Conflict | null): string {
  if (!c) return EDITOR.conflict(null, null);
  const subject = !c.subject
    ? null
    : c.code === 'room_missing' || c.code === 'room_in_use' || c.code === 'room_exists'
      ? roomName(c.subject)
      : c.code === 'not_placed' || c.code === 'already_placed'
        ? itemName(c.subject)
        : null;
  return EDITOR.conflict(c.code, subject);
}

/** Editing needs the editor role and a writable layout (data contract §2.3). */
export function canEdit(): boolean {
  const { me, model } = useData.getState();
  return me?.role === 'editor' && !!model?.snapshot.house && !model.snapshot.houseReadOnly;
}

const placementOf = (itemId: string): LayoutPlacement | null =>
  (house()?.placements ?? []).find((p) => p.itemId === itemId) ?? null;

export const useEditor: UseBoundStore<StoreApi<EditorState>> = create<EditorState>()((set, get) => {
  const notify = (tone: Notice['tone'], text: string) =>
    set((s) => ({ notices: [...s.notices.slice(-4), { id: nextId++, tone, text }] }));

  const show = (layout: Layout) => useData.getState().showLayout(layout);

  const schedule = (delay = SAVE_DELAY_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void get().saveNow();
    }, delay);
  };

  /** Start tracking unsaved edits: the layout shown now is the server's. */
  const beginPending = () => {
    if (get().pending.length) return;
    const snap = useData.getState().model?.snapshot;
    set({ base: snap?.house ?? null, baseEtag: snap?.houseEtag ?? null });
  };

  /** A history entry by id, wherever it is. */
  const patchEntry = (id: number, patch: Partial<HistoryEntry>) =>
    set((s) => ({
      undo: s.undo.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      redo: s.redo.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));

  const shiftHistory = (dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    const move = (e: HistoryEntry): HistoryEntry => ({
      ...e,
      cmd: shiftCommand(e.cmd, dx, dy),
      inverse: shiftCommand(e.inverse, dx, dy),
    });
    set((s) => ({
      undo: s.undo.map(move),
      redo: s.redo.map(move),
      pending: s.pending.map((r) => ({ ...r, cmd: shiftCommand(r.cmd, dx, dy) })),
    }));
  };

  /**
   * Another writer's layout `server` follows `prev` (the server layout our history and pending
   * commands were made on). If the house was resized meanwhile, commands carry coordinates of
   * the old grid (M5-02): translate them when the change was exactly a resize with one possible
   * shift; otherwise drop the pending ones and the history, and say so. Returns false when the
   * pending commands were dropped.
   */
  const reframe = (prev: House | null, server: House): boolean => {
    if (!prev) return true;
    const shift = inferShift(prev, server, applyContext().footprintOf);
    if (shift) {
      shiftHistory(shift.dx, shift.dy);
      return true;
    }
    const { pending, undo, redo } = get();
    const labels = new Map([...undo, ...redo].map((e) => [e.id, e.label]));
    for (const r of pending)
      if (r.dir === 'do' && labels.has(r.entryId))
        notify(
          'warn',
          EDITOR.dropped(labels.get(r.entryId)!, EDITOR.conflict('grid_changed', null)),
        );
    if (undo.length || redo.length) notify('info', EDITOR.historyCleared);
    set({ pending: [], undo: [], redo: [] });
    return false;
  };

  /**
   * Replay the pending commands on a layout from the server and make it the new base. Dropped
   * commands leave the history and are reported. Returns the layout to show. `external`: the
   * layout may contain other writers' changes (412, SSE), not just what we sent.
   */
  const rebase = (server: House, etag: string | null, external = true): House => {
    if (external && unconfirmed && canonicalLayout(server) === unconfirmed.body) {
      // Our save went through after all; its commands are done (no replay, no reframing).
      set((s) => ({ pending: s.pending.slice(unconfirmed!.n) }));
      external = false;
    }
    unconfirmed = null;
    if (external) reframe(get().base, server);
    const { pending, undo, redo } = get();
    const r = replay(server, pending, applyContext());
    const labels = new Map([...undo, ...redo].map((e) => [e.id, e.label]));
    // A replay that changed nothing (the effect was already there) has an empty inverse: keep
    // the one computed when the edit was made, so undo still undoes it (M5-01).
    for (const { rec, inverse, changed } of r.kept)
      if (changed) patchEntry(rec.entryId, rec.dir === 'do' ? { inverse } : { cmd: inverse });
    const gone = new Set(r.dropped.map((d) => d.rec.entryId));
    for (const d of r.dropped) {
      if (!d.conflict) continue;
      const label = labels.get(d.rec.entryId) ?? '';
      notify(
        'warn',
        d.rec.dir === 'do'
          ? EDITOR.dropped(label, conflictText(d.conflict))
          : EDITOR.undoFailed(label, conflictText(d.conflict)),
      );
    }
    set((s) => ({
      base: server,
      baseEtag: etag,
      pending: r.kept.map((k) => k.rec),
      undo: s.undo.filter((e) => !gone.has(e.id)),
      redo: s.redo.filter((e) => !gone.has(e.id)),
    }));
    return r.layout;
  };

  /** Forget unsaved edits (the layout is read-only now, or the user discarded them). */
  const dropPending = () => {
    unconfirmed = null;
    if (timer) clearTimeout(timer);
    timer = null;
    set({ pending: [], undo: [], redo: [], save: 'saved', saveError: null, saveFatal: false });
  };

  /** The layout can't be written any more: drop the unsaved edits and say why (D25). */
  const goReadOnly = () => {
    notify('error', EDITOR.saveReadOnly);
    dropPending();
    set({ mode: 'view', gesture: null, base: null, baseEtag: null });
  };

  // Layouts arriving from the server while edits are pending (called inside the data queue).
  setHouseInterceptor(({ house: server, etag, readOnly }) => {
    const s = get();
    if (!s.pending.length) {
      if (readOnly && s.mode === 'edit') set({ mode: 'view', gesture: null });
      // Nothing pending, but the history is in the grid shown so far (M5-02).
      const shown = house();
      if (server && shown && !readOnly && (s.undo.length || s.redo.length)) reframe(shown, server);
      return server;
    }
    if (!server || readOnly) {
      goReadOnly();
      return server;
    }
    if (sameEtag(etag, s.baseEtag)) return house() ?? server;
    const local = rebase(server, etag);
    if (get().pending.length) schedule();
    else set({ save: 'saved' });
    return local;
  });

  /** Apply `cmd` as a new history entry. */
  const run = (cmd: Command, label: string): boolean => {
    const h = house();
    if (!h || !canEdit()) return false;
    const r = applyCommand(h, cmd, applyContext());
    if (!r.ok) {
      notify('warn', EDITOR.editFailed(conflictText(r.conflict)));
      return false;
    }
    if (!r.changed) return true;
    beginPending();
    const entry: HistoryEntry = { id: nextId++, label, cmd, inverse: r.inverse };
    set((s) => ({
      undo: [...s.undo, entry].slice(-MAX_HISTORY),
      redo: [],
      pending: [...s.pending, { entryId: entry.id, dir: 'do', cmd }],
      save: s.save === 'error' ? 'error' : 'pending',
    }));
    show(r.layout);
    schedule();
    return true;
  };

  const step = (dir: 'undo' | 'redo') => {
    const s = get();
    const stack = dir === 'undo' ? s.undo : s.redo;
    const entry = stack.at(-1);
    const h = house();
    if (!entry || !h || !canEdit()) return;
    const cmd = dir === 'undo' ? entry.inverse : entry.cmd;
    const r = applyCommand(h, cmd, applyContext());
    if (!r.ok) {
      const why = conflictText(r.conflict);
      notify(
        'warn',
        dir === 'undo' ? EDITOR.undoFailed(entry.label, why) : EDITOR.redoFailed(entry.label, why),
      );
      // It can't be undone (or redone) any more: drop it rather than block the stack. Below a
      // resize that can't be undone, every entry is in a grid that no longer exists: drop all.
      const all =
        cmd.kind === 'resize' || (cmd.kind === 'batch' && cmd.commands[0]?.kind === 'resize');
      set((st) =>
        dir === 'undo'
          ? { undo: all ? [] : st.undo.slice(0, -1) }
          : { redo: all ? [] : st.redo.slice(0, -1) },
      );
      return;
    }
    // Undoing a repair (D30) after it was saved brings a problem back that the file on disk no
    // longer has; the server refuses that. Say so and skip the entry.
    const disk = s.pending.length ? s.base : h;
    if (r.changed && disk && addsProblems(r.layout, disk, applyContext().footprintOf)) {
      notify(
        'info',
        dir === 'undo' ? EDITOR.undoRepairSaved(entry.label) : EDITOR.redoRepairSaved(entry.label),
      );
      set((st) =>
        dir === 'undo' ? { undo: st.undo.slice(0, -1) } : { redo: st.redo.slice(0, -1) },
      );
      return;
    }
    beginPending();
    const moved: HistoryEntry =
      dir === 'undo' ? { ...entry, cmd: r.inverse } : { ...entry, inverse: r.inverse };
    set((st) => ({
      undo: dir === 'undo' ? st.undo.slice(0, -1) : [...st.undo, moved],
      redo: dir === 'undo' ? [...st.redo, moved] : st.redo.slice(0, -1),
      pending: [...st.pending, { entryId: entry.id, dir: dir === 'undo' ? 'undo' : 'do', cmd }],
      save: st.save === 'error' ? 'error' : 'pending',
    }));
    if (r.changed) show(r.layout);
    schedule();
  };

  const placeItemAt = (itemId: string, floorId: string, cell: Cell): boolean => {
    const h = house();
    if (!h) return false;
    const prev = placementOf(itemId);
    // An item placed on a floor that no longer exists is in the tray too: move it then.
    const to: LayoutPlacement = { itemId, floorId, x: cell.x, y: cell.y, rotation: 0 };
    const fitted = movedPlacement(to, 0, 0, h.grid, applyContext().footprintOf) ?? to;
    return run(
      { kind: 'placement', itemId, to: fitted, requires: prev ? 'placed' : 'unplaced' },
      EDITOR.label.place(itemName(itemId)),
    );
  };

  return {
    mode: 'view',
    tool: 'select',
    paintRoomId: null,
    place: null,
    gesture: null,
    hover: null,
    draft: null,
    undo: [],
    redo: [],
    pending: [],
    base: null,
    baseEtag: null,
    save: 'saved',
    saveError: null,
    saveFatal: false,
    notices: [],

    setMode: (mode) => {
      if (mode === 'edit' && !canEdit()) return;
      if (mode === 'view') void get().saveNow();
      if (mode === 'edit') {
        useUi.getState().setView('plan');
        const rooms = house()?.rooms ?? [];
        if (!rooms.some((r) => r.id === get().paintRoomId))
          set({ paintRoomId: rooms[0]?.id ?? null });
      }
      set({ mode, tool: 'select', place: null, gesture: null, hover: null, draft: null });
    },
    setTool: (tool) =>
      set((s) => ({ tool, place: tool === 'place' ? s.place : null, gesture: null })),
    setPaintRoom: (paintRoomId) => set({ paintRoomId, tool: 'paint', place: null, gesture: null }),
    armPlace: (place) => set({ place, tool: 'place', gesture: null }),
    cancel: () => {
      const s = get();
      if (s.gesture) set({ gesture: null });
      else if (s.tool !== 'select') set({ tool: 'select', place: null, hover: null });
    },
    setGesture: (gesture) => set({ gesture }),
    setHover: (hover) => {
      const cur = get().hover;
      if (
        cur === hover ||
        (cur &&
          hover &&
          cur.floorId === hover.floorId &&
          cur.cell.x === hover.cell.x &&
          cur.cell.y === hover.cell.y &&
          cur.edge?.x === hover.edge?.x &&
          cur.edge?.y === hover.edge?.y &&
          cur.edge?.side === hover.edge?.side)
      )
        return;
      set({ hover });
    },
    setDraft: (draft) => set({ draft }),

    run,
    undoLast: () => step('undo'),
    redoLast: () => step('redo'),

    paintRect: (floorId, from, to, erase) => {
      const roomId = erase ? null : get().paintRoomId;
      if (!erase && !roomId) {
        notify('info', EDITOR.toolHint.paintNoRoom);
        return;
      }
      const cells = rectCells(rectBetween(from, to));
      // Only the tiles that change count (and are labelled).
      const floor = house()?.floors.find((f) => f.id === floorId);
      const changing = cells.filter((c) => (floor?.cells?.[cellKey(c.x, c.y)] ?? null) !== roomId);
      // #14: the first tiles of a room on this floor, while it is on other floors already.
      const elsewhere =
        roomId && house() ? roomFloors(house()!, roomId).filter((f) => f.id !== floorId) : [];
      const first = elsewhere.length > 0 && !Object.values(floor?.cells ?? {}).includes(roomId!);
      const ok = run(
        { kind: 'cells', floorId, set: cells.map((c) => [c.x, c.y, roomId]) },
        erase
          ? EDITOR.label.erase(changing.length)
          : EDITOR.label.paint(changing.length, roomName(roomId!)),
      );
      if (ok && first && changing.length > 0)
        notify(
          'info',
          EDITOR.sharedRoomPaint(
            roomName(roomId!),
            elsewhere.map((f) => f.name),
          ),
        );
    },

    moveItem: (itemId, dx, dy) => {
      const p = placementOf(itemId);
      const h = house();
      if (!p || !h) return;
      const to = movedPlacement(p, dx, dy, h.grid, applyContext().footprintOf);
      if (!to || (to.x === p.x && to.y === p.y)) return;
      run(
        { kind: 'placement', itemId, to, requires: 'placed' },
        EDITOR.label.move(itemName(itemId)),
      );
    },

    rotateItem: (itemId) => {
      const p = placementOf(itemId);
      const h = house();
      if (!p || !h) return;
      const to = rotatedPlacement(p, h.grid, applyContext().footprintOf);
      if (!to) {
        notify('info', EDITOR.rotateNoRoom);
        return;
      }
      run(
        { kind: 'placement', itemId, to, requires: 'placed' },
        EDITOR.label.rotate(itemName(itemId)),
      );
    },

    unplaceItem: (itemId) => {
      if (!placementOf(itemId)) return;
      run(
        { kind: 'placement', itemId, to: null, requires: 'placed' },
        EDITOR.label.unplace(itemName(itemId)),
      );
    },

    placeAt: (floorId, cell) => {
      const src = get().place;
      if (!src) return;
      if (src.kind === 'type') {
        set({ draft: { type: src.type, floorId, cell } });
        return;
      }
      if (placeItemAt(src.itemId, floorId, cell)) {
        set({ place: null, tool: 'select', hover: null });
        useUi.getState().select({ kind: 'item', id: src.itemId });
      }
    },

    placeItemAt,

    createAndPlace: async (draft, name) => {
      const h = house();
      const roomId = h?.floors.find((f) => f.id === draft.floorId)?.cells?.[
        cellKey(draft.cell.x, draft.cell.y)
      ];
      const item = await useData
        .getState()
        .createItem({ type: draft.type, name, ...(roomId ? { roomId } : {}) });
      placeItemAt(item.id, draft.floorId, draft.cell);
      set({ draft: null, place: null, tool: 'select', hover: null });
      useUi.getState().select({ kind: 'item', id: item.id });
      return item;
    },

    relinkGhost: (ghostId, itemId) => {
      const p = placementOf(ghostId);
      if (!p) return;
      const ok = run(
        {
          kind: 'batch',
          commands: [
            { kind: 'placement', itemId: ghostId, to: null, requires: 'placed' },
            { kind: 'placement', itemId, to: { ...p, itemId }, requires: 'unplaced' },
          ],
        },
        EDITOR.label.relink(ghostId, itemName(itemId)),
      );
      if (ok) useUi.getState().select({ kind: 'item', id: itemId });
    },

    removeGhost: (ghostId) => {
      if (!placementOf(ghostId)) return;
      if (
        run(
          { kind: 'placement', itemId: ghostId, to: null, requires: 'placed' },
          EDITOR.label.removeGhost(ghostId),
        )
      )
        useUi.getState().select(null);
    },

    addRoom: () => {
      const h = house();
      if (!h) return null;
      const rooms = h.rooms ?? [];
      const names = new Set(rooms.map((r) => r.name));
      let n = rooms.length + 1;
      while (names.has(EDITOR.roomDefaultName(n))) n++;
      const color = nextRoomColor(rooms);
      const room = {
        id: newRoomId(new Set(rooms.map((r) => r.id))),
        name: EDITOR.roomDefaultName(n),
        color,
      };
      if (!run({ kind: 'room.add', room }, EDITOR.label.roomAdd(room.name))) return null;
      set({ paintRoomId: room.id, tool: 'paint', place: null });
      return room.id;
    },

    renameRoom: (roomId, name) => {
      const clean = cleanRoomName(name);
      if (!clean) {
        notify('warn', EDITOR.roomNameInvalid);
        return false;
      }
      const from = roomName(roomId);
      if (clean === from) return true;
      const ok = run(
        { kind: 'room.update', id: roomId, name: clean },
        EDITOR.label.roomRename(from, clean),
      );
      const floors = roomFloors(house() ?? { floors: [] }, roomId);
      if (ok && floors.length > 1)
        notify(
          'info',
          EDITOR.sharedRoomRenamed(
            clean,
            floors.map((f) => f.name),
          ),
        );
      return ok;
    },

    recolorRoom: (roomId, color) => {
      if (!isRoomColor(color)) return;
      const cur = (house()?.rooms ?? []).find((r) => r.id === roomId);
      if (!cur || cur.color.toLowerCase() === color.toLowerCase()) return;
      // A colour picker fires on every move: fold consecutive recolours of one room into one step.
      const last = get().undo.at(-1);
      const pendingLast = get().pending.at(-1);
      if (
        last &&
        last.cmd.kind === 'room.update' &&
        last.cmd.id === roomId &&
        last.cmd.color !== undefined &&
        last.cmd.name === undefined &&
        pendingLast?.entryId === last.id &&
        get().redo.length === 0
      ) {
        const r = applyCommand(
          house()!,
          { kind: 'room.update', id: roomId, color },
          applyContext(),
        );
        if (!r.ok) return;
        // Replace the pending command (not add one): replayed on the base, its inverse is
        // still the colour before the first change.
        const cmd: Command = { kind: 'room.update', id: roomId, color };
        set((s) => ({
          undo: [...s.undo.slice(0, -1), { ...last, cmd }],
          pending: [...s.pending.slice(0, -1), { entryId: last.id, dir: 'do', cmd }],
        }));
        show(r.layout);
        schedule();
        return;
      }
      const ok = run({ kind: 'room.update', id: roomId, color }, EDITOR.label.roomColor(cur.name));
      // Once per recolour, not for every move of the picker (those fold into the step above).
      const floors = roomFloors(house() ?? { floors: [] }, roomId);
      if (ok && floors.length > 1)
        notify(
          'info',
          EDITOR.sharedRoomRecoloured(
            cur.name,
            floors.map((f) => f.name),
          ),
        );
    },

    setRoomFinish: (roomId, change) => {
      run(
        { kind: 'room.update', id: roomId, ...change },
        EDITOR.label.roomFinish(roomName(roomId)),
      );
    },

    copyFinish: (fromId, toIds) => {
      const from = (house()?.rooms ?? []).find((r) => r.id === fromId);
      const targets = toIds.filter((id) => id !== fromId);
      if (!from || targets.length === 0) return;
      run(
        {
          kind: 'batch',
          commands: targets.map((id) => ({
            kind: 'room.update' as const,
            id,
            floor: from.floor ?? null,
            walls: from.walls ?? null,
          })),
        },
        EDITOR.label.finishCopy(from.name, targets.length),
      );
    },

    setExteriorWallColor: (color) => {
      if (color !== null && !isRoomColor(color)) return;
      run({ kind: 'house.update', exteriorWallColor: color }, EDITOR.label.exteriorWalls);
    },

    deleteRoom: (roomId) => {
      const name = roomName(roomId);
      if (run({ kind: 'room.remove', id: roomId }, EDITOR.label.roomRemove(name))) {
        if (get().paintRoomId === roomId)
          set({ paintRoomId: (house()?.rooms ?? [])[0]?.id ?? null });
        const sel = useUi.getState().selection;
        if (sel?.kind === 'room' && sel.roomId === roomId) useUi.getState().select(null);
      }
    },

    toggleOpening: (floorId, edge, kind) => {
      const h = house();
      const floor = h?.floors.find((f) => f.id === floorId);
      if (!h || !floor) return false;
      if (!isWallEdge(floor.cells, edge, h.grid)) {
        notify('warn', EDITOR.openingNotWall);
        return false;
      }
      const here = (h.openings ?? []).find(
        (o) => o.floorId === floorId && o.x === edge.x && o.y === edge.y && o.side === edge.side,
      );
      if (here?.kind === kind)
        return run({ kind: 'openings', add: [], remove: [here] }, EDITOR.label.openingRemove(kind));
      const opening = { floorId, x: edge.x, y: edge.y, side: edge.side, kind };
      return run(
        { kind: 'openings', add: [opening], remove: [] },
        here ? EDITOR.label.openingSwap(here.kind, kind) : EDITOR.label.openingAdd(kind),
      );
    },

    addFloor: (where) => {
      const h = house();
      if (!h) return null;
      const levels = h.floors.map((f) => f.level);
      const level = where === 'above' ? Math.max(...levels) + 1 : Math.min(...levels) - 1;
      if (level > MAX_LEVEL || level < MIN_LEVEL) {
        notify('warn', EDITOR.floorLevelLimit);
        return null;
      }
      const names = new Set(h.floors.map((f) => f.name));
      const base = EDITOR.floorDefaultName(level);
      let name = base;
      for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
      const floor = { id: newFloorId(new Set(h.floors.map((f) => f.id))), name, level, cells: {} };
      if (!run({ kind: 'floor.add', floor }, EDITOR.label.floorAdd(name))) return null;
      useUi.getState().setFloor(floor.id);
      return floor.id;
    },

    renameFloor: (floorId, name) => {
      const clean = cleanRoomName(name); // same rule: 1–100 characters
      if (!clean) {
        notify('warn', EDITOR.floorNameInvalid);
        return false;
      }
      const from = floorName(floorId);
      if (clean === from) return true;
      return run(
        { kind: 'floor.update', id: floorId, name: clean },
        EDITOR.label.floorRename(from, clean),
      );
    },

    moveFloor: (floorId, dir) => {
      const floors = floorsByLevel();
      const i = floors.findIndex((f) => f.id === floorId);
      const other = floors[dir === 'up' ? i - 1 : i + 1];
      if (i < 0 || !other) return;
      const me = floors[i]!;
      // Swap levels; equal levels (a hand edit) become one apart.
      const mine = other.level === me.level ? me.level + (dir === 'up' ? 1 : -1) : other.level;
      if (mine > MAX_LEVEL || mine < MIN_LEVEL) {
        notify('warn', EDITOR.floorLevelLimit);
        return;
      }
      run(
        {
          kind: 'batch',
          commands: [
            { kind: 'floor.update', id: me.id, level: mine },
            { kind: 'floor.update', id: other.id, level: me.level },
          ],
        },
        EDITOR.label.floorMove(me.name, dir),
      );
    },

    deleteFloor: (floorId) => {
      const h = house();
      if (!h) return false;
      const loss = floorLoss(h, floorId);
      const name = floorName(floorId);
      const ok = run(
        {
          kind: 'floor.remove',
          id: floorId,
          confirmed: {
            tiles: loss.tiles,
            items: loss.placements.map((p) => p.placement.itemId),
            openings: loss.openings.length,
          },
        },
        EDITOR.label.floorRemove(name),
      );
      if (ok && useUi.getState().floorId === floorId) {
        const next = floorsByLevel()[0];
        if (next) useUi.getState().setFloor(next.id);
      }
      return ok;
    },

    resize: (by, allowLoss) => {
      const h = house();
      if (!h) return false;
      const from = { width: h.grid.width, depth: h.grid.depth };
      const to = resizedSize(from, by);
      return run({ kind: 'resize', from, by, allowLoss }, EDITOR.label.resize(to.width, to.depth));
    },

    repair: (issue, fix) => {
      const h = house();
      if (!h) return false;
      const rooms = h.rooms ?? [];
      // A missing room's "id" that isn't one is usually its name typed by hand (M5-08): keep it.
      const typed =
        issue.kind === 'unknown_room' && !isValidId(issue.roomId)
          ? cleanRoomName(issue.roomId)
          : null;
      let name: string = typed ?? EDITOR.repair.recoveredRoom(1);
      for (let n = 2; !typed && rooms.some((r) => r.name === name); n++)
        name = EDITOR.repair.recoveredRoom(n);
      const id = newRoomId(new Set(rooms.map((r) => r.id)));
      const cmd = repairCommand(h, issue, fix, { id, name, color: nextRoomColor(rooms) });
      return !!cmd && run(cmd, EDITOR.repair.label(issue, fix, itemName));
    },

    saveNow: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (saving) {
        again = true;
        return;
      }
      if (!get().pending.length) return;
      saving = true;
      set({ save: 'saving' });
      let retryIn: number | null = null;
      try {
        await runExclusive(async () => {
          for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
            const s = get();
            const local = house();
            if (!s.pending.length || !local) return;
            const n = s.pending.length;
            try {
              const res = await putHouse(local, s.baseEtag);
              // Edits made while the request was out stay pending, on top of what was written.
              const rest = get().pending.slice(n);
              set({ pending: rest });
              unconfirmed = null;
              const shown = rebase(res.house, res.etag, false);
              useData.getState().layoutSaved(res.etag, shown);
              return;
            } catch (e) {
              // No answer at all: the server may have written it (M5-01).
              if (!(e instanceof ApiError)) unconfirmed = { body: canonicalLayout(local), n };
              if (!(e instanceof ApiError && e.status === 412)) throw e;
              const fresh = await fetchHouse();
              if (!fresh) throw e;
              // house.json became unusable (M5-10): no replay, no retry loop.
              if (fresh.readOnly) {
                goReadOnly();
                // The snapshot carries the read-only state and its banner.
                void useData.getState().load();
                return;
              }
              const shown = rebase(fresh.house, fresh.etag);
              useData.getState().layoutSaved(fresh.etag, shown);
            }
          }
          throw new Error('the layout kept changing on the server');
        });
        failures = 0;
        set((s) => ({
          save: s.pending.length ? 'pending' : 'saved',
          saveError: null,
          saveFatal: false,
        }));
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        const why =
          e instanceof ApiError
            ? (e.detail ?? e.message)
            : e instanceof Error
              ? e.message
              : String(e);
        const fatal = status === 422 || status === 409 || status === 403 || status === 413;
        set({
          save: 'error',
          saveFatal: fatal,
          saveError:
            status === 409
              ? EDITOR.saveReadOnly
              : status === 422
                ? EDITOR.saveRejected(why)
                : EDITOR.saveFailed(why),
        });
        // Out of edit mode the side bar's save state isn't shown: say it here.
        if (get().mode !== 'edit') notify('error', get().saveError ?? EDITOR.save.error);
        if (!fatal) retryIn = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!;
        failures += 1;
      } finally {
        saving = false;
      }
      if (again && get().pending.length) {
        again = false;
        schedule(retryIn ?? SAVE_DELAY_MS);
      } else if (retryIn !== null) schedule(retryIn);
      again = false;
    },

    discard: () => {
      if (saving) return;
      const base = get().base;
      dropPending();
      if (base) show(base);
    },

    notify,
    dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  };
});

/** True while there are layout edits the server hasn't got yet. */
export const hasUnsaved = (): boolean => useEditor.getState().pending.length > 0 || saving;

// Leaving the page with edits not saved yet: let the browser ask.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = EDITOR.leaveWarning;
  });
}

/** For tests: forget timers and module state. */
export function resetEditorForTests(): void {
  deletedNotes.clear();
  unconfirmed = null;
  if (timer) clearTimeout(timer);
  timer = null;
  saving = false;
  again = false;
  failures = 0;
  useEditor.setState({
    mode: 'view',
    tool: 'select',
    paintRoomId: null,
    place: null,
    gesture: null,
    hover: null,
    draft: null,
    undo: [],
    redo: [],
    pending: [],
    base: null,
    baseEtag: null,
    save: 'saved',
    saveError: null,
    saveFatal: false,
    notices: [],
  });
}
