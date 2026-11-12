/**
 * Layout edits as commands (DESIGN §7.3, 15.2). A command is plain data describing an intent;
 * `applyCommand` turns it into a new layout plus its exact inverse, or refuses with a conflict
 * when it no longer makes sense (the room it paints with was deleted elsewhere, the item it
 * moves was removed, the grid was resized under it…).
 *
 * The same function serves new edits, undo/redo (apply the inverse) and replay after a `412`
 * (apply the pending commands to the fresh layout). Commands are **idempotent where it
 * matters**: an effect that is already there is a no-op, not a conflict, so a save whose
 * response was lost replays cleanly.
 *
 * Pure: imports only `domain/`.
 */
import { type Cell, cellKey, parseCellKey } from '../domain/coords';
import {
  type FootprintOf,
  type Layout,
  type LayoutFloor,
  type LayoutOpening,
  type LayoutPlacement,
  type LayoutRoom,
  type ResizeDeltas,
  type ResizeLoss,
  insideGrid,
  lossKeys,
  openingKey,
  placementRect,
  rectInsideGrid,
  resizeLayout,
  resizedSize,
  sizeAllowed,
} from '../domain/layout';

/** Set (roomId) or clear (null) tiles of one floor: paint, erase, rectangle paint (D17a). */
export interface CellsCommand {
  kind: 'cells';
  floorId: string;
  set: [x: number, y: number, roomId: string | null][];
  /**
   * A repair (D30) or its undo: tiles may be outside the grid or point to a missing room. Only
   * repairs set it; ordinary edits can't create either problem.
   */
  repair?: true;
}

/**
 * Set or remove an item's placement: place, move, rotate, remove from plan. `requires` says
 * what must be true first: `placed` (move, rotate, remove: the placement must still exist),
 * `unplaced` (placing from the tray or the catalogue: nobody placed it meanwhile).
 */
export interface PlacementCommand {
  kind: 'placement';
  itemId: string;
  to: LayoutPlacement | null;
  requires: 'placed' | 'unplaced' | 'any';
  /** Where a new placement goes in the list (stacking order); the end by default. Undoing a
   *  removal puts the placement back where it was. */
  index?: number;
  /** A repair (D30) or its undo: the placement may be on a missing floor or outside the grid. */
  repair?: true;
  /**
   * Repairs only (M5-09): act on the copy equal to `match` (an item may be placed more than
   * once), or with `insert`, add `to` at `index` as a further copy. Undo of one is the other.
   */
  match?: LayoutPlacement;
  insert?: true;
}

export interface RoomAddCommand {
  kind: 'room.add';
  room: LayoutRoom;
  /** Recreating a missing room (D30): its undo removes the room although tiles still use it. */
  repair?: true;
}
export interface RoomUpdateCommand {
  kind: 'room.update';
  id: string;
  name?: string;
  color?: string;
  /** Floor finish key (D41); null removes it. */
  floor?: string | null;
  /** Wall finish: paint `#RRGGBB` or wallpaper key; null removes it. */
  walls?: string | null;
}
/** House-wide settings (D41): the colour of the outside walls; null removes it. */
export interface HouseUpdateCommand {
  kind: 'house.update';
  exteriorWallColor?: string | null;
}
export interface RoomRemoveCommand {
  kind: 'room.remove';
  id: string;
  /** The undo of recreating a missing room: tiles may keep pointing to it. */
  repair?: true;
}

/**
 * Add a floor (D35) at `index` in the list (the end by default). As the undo of `floor.remove`,
 * `restore` puts the placements and doors/windows that were on it back where they were in
 * house.json.
 */
export interface FloorAddCommand {
  kind: 'floor.add';
  floor: LayoutFloor;
  index?: number;
  restore?: {
    placements: { index: number; placement: LayoutPlacement }[];
    openings: { index: number; opening: LayoutOpening }[];
  };
}
export interface FloorUpdateCommand {
  kind: 'floor.update';
  id: string;
  name?: string;
  level?: number;
}
/**
 * Remove a floor with its tiles, placements (the items go to the Unplaced tray; notes are never
 * touched) and doors/windows. `confirmed` is what the user saw go: on replay, more tiles or
 * other items on the floor are a conflict (`more_lost`), as for a resize. Never the last floor.
 */
export interface FloorRemoveCommand {
  kind: 'floor.remove';
  id: string;
  confirmed: { tiles: number; items: string[]; openings: number };
}

/** Add (replacing the same edge) or remove openings; used to restore what a resize cut. */
export interface OpeningsCommand {
  kind: 'openings';
  add: LayoutOpening[];
  remove: LayoutOpening[];
  /** Where each new edge of `add` goes in the list (same order as `add`); the end by default.
   *  Undo puts removed edges back where they were, so house.json doesn't reorder. */
  addAt?: number[];
  /** A repair (D30) or its undo: edges may be outside the grid or on a missing floor. */
  repair?: true;
}

/**
 * Resize the grid (D17b). `from` is the size the user saw; `allowLoss` the keys (`lossKeys`)
 * of what they confirmed losing. On replay a different size, or a loss beyond the confirmed
 * one, is a conflict: nothing is cut that the user didn't see.
 */
export interface ResizeCommand {
  kind: 'resize';
  from: { width: number; depth: number };
  by: ResizeDeltas;
  allowLoss: string[];
}

/**
 * "Keep the first" (D30): remove the second and later placements of an item placed more than
 * once. With `restore`, the opposite: put those placements back at their old indexes (the
 * inverse). A no-op when the item is placed once and nothing is to be restored.
 */
export interface DedupeCommand {
  kind: 'dedupe';
  itemId: string;
  restore?: { index: number; placement: LayoutPlacement }[];
}

/** Several commands as one undo step; all or nothing. */
export interface BatchCommand {
  kind: 'batch';
  commands: Command[];
}

export type Command =
  | CellsCommand
  | PlacementCommand
  | FloorAddCommand
  | FloorUpdateCommand
  | FloorRemoveCommand
  | RoomAddCommand
  | RoomUpdateCommand
  | RoomRemoveCommand
  | HouseUpdateCommand
  | OpeningsCommand
  | ResizeCommand
  | DedupeCommand
  | BatchCommand;

export type ConflictCode =
  | 'floor_missing'
  | 'floor_exists'
  | 'last_floor'
  | 'room_missing'
  | 'room_exists'
  | 'room_in_use'
  | 'outside_grid'
  | 'not_placed'
  | 'already_placed'
  | 'note_deleted'
  | 'grid_changed'
  | 'size_invalid'
  | 'more_lost';

export interface Conflict {
  code: ConflictCode;
  /** The id the conflict is about (room, item, floor), for messages. */
  subject?: string;
}

export type ApplyResult =
  | { ok: true; layout: Layout; inverse: Command; changed: boolean }
  | { ok: false; conflict: Conflict };

export interface ApplyContext {
  /** Footprint of an item without a placement override (catalogue; 1×1 for unknown). */
  footprintOf: FootprintOf;
  /**
   * Whether the item's note was deleted in this app (D32). Such an item can't be placed again:
   * undoing "remove from plan" after the delete would bring it back as a ghost. Placements of
   * notes that are merely missing (ghosts) are unaffected, so their relink and removal undo.
   */
  noteDeleted?: (itemId: string) => boolean;
}

const fail = (code: ConflictCode, subject?: string): ApplyResult => ({
  ok: false,
  conflict: subject === undefined ? { code } : { code, subject },
});

const samePlacement = (a: LayoutPlacement | null, b: LayoutPlacement | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.itemId === b.itemId &&
    a.floorId === b.floorId &&
    a.x === b.x &&
    a.y === b.y &&
    a.rotation === b.rotation &&
    (a.footprint ?? null)?.join() === (b.footprint ?? null)?.join());

function applyCells(l: Layout, c: CellsCommand): ApplyResult {
  const fi = l.floors.findIndex((f) => f.id === c.floorId);
  if (fi < 0) return fail('floor_missing', c.floorId);
  const rooms = new Set((l.rooms ?? []).map((r) => r.id));
  const floor = l.floors[fi]!;
  const cells = { ...(floor.cells ?? {}) };
  const undo: CellsCommand['set'] = [];
  for (const [x, y, roomId] of c.set) {
    if (!c.repair && !insideGrid({ x, y }, l.grid)) return fail('outside_grid');
    if (!c.repair && roomId !== null && !rooms.has(roomId)) return fail('room_missing', roomId);
    const key = cellKey(x, y);
    const prev = cells[key] ?? null;
    if (prev === roomId) continue;
    undo.push([x, y, prev]);
    if (roomId === null) delete cells[key];
    else cells[key] = roomId;
  }
  const inverse: CellsCommand = {
    kind: 'cells',
    floorId: c.floorId,
    set: undo.reverse(),
    ...(c.repair ? { repair: true as const } : {}),
  };
  if (undo.length === 0) return { ok: true, layout: l, inverse, changed: false };
  const floors = l.floors.map((f, i) => (i === fi ? { ...f, cells } : f));
  return { ok: true, layout: { ...l, floors }, inverse, changed: true };
}

/** Remove one exact copy (`match`), or insert one (`insert`): repairs of items placed twice. */
function applyPlacementCopy(l: Layout, c: PlacementCommand): ApplyResult {
  const list = l.placements ?? [];
  if (c.insert && c.to) {
    const i = Math.min(Math.max(0, c.index ?? list.length), list.length);
    return {
      ok: true,
      layout: { ...l, placements: [...list.slice(0, i), c.to, ...list.slice(i)] },
      inverse: {
        kind: 'placement',
        itemId: c.itemId,
        to: null,
        requires: 'placed',
        match: c.to,
        repair: true,
      },
      changed: true,
    };
  }
  const at = list.findIndex((p) => samePlacement(p, c.match!));
  const inverse: PlacementCommand = {
    kind: 'placement',
    itemId: c.itemId,
    to: c.match!,
    requires: 'any',
    insert: true,
    index: at,
    repair: true,
  };
  // Already gone: nothing to do (idempotent), and nothing to put back.
  if (at < 0)
    return { ok: true, layout: l, inverse: { kind: 'batch', commands: [] }, changed: false };
  return {
    ok: true,
    layout: { ...l, placements: list.filter((_, i) => i !== at) },
    inverse,
    changed: true,
  };
}

function applyPlacement(l: Layout, c: PlacementCommand, ctx: ApplyContext): ApplyResult {
  if (c.insert || c.match) return applyPlacementCopy(l, c);
  const list = l.placements ?? [];
  const at = list.findIndex((p) => p.itemId === c.itemId);
  const prev = at >= 0 ? list[at]! : null;
  const inverse: PlacementCommand = {
    kind: 'placement',
    itemId: c.itemId,
    to: prev,
    requires: c.to ? 'placed' : 'unplaced',
    ...(prev && !c.to ? { index: at } : {}),
    ...(c.repair ? { repair: true as const } : {}),
  };
  // Already the way the command wants it: a no-op, whatever `requires` says (idempotence).
  if (samePlacement(prev, c.to)) return { ok: true, layout: l, inverse, changed: false };
  if (c.requires === 'placed' && !prev) return fail('not_placed', c.itemId);
  if (c.requires === 'unplaced' && prev) return fail('already_placed', c.itemId);
  if (c.to) {
    if (c.to.itemId !== c.itemId) throw new Error('placement command for another item');
    const to = c.to;
    // A repair's undo puts a placement back where it was, valid or not.
    if (!c.repair) {
      if (!prev && ctx.noteDeleted?.(c.itemId)) return fail('note_deleted', c.itemId);
      if (!l.floors.some((f) => f.id === to.floorId)) return fail('floor_missing', to.floorId);
      if (!rectInsideGrid(placementRect(to, ctx.footprintOf), l.grid))
        return fail('outside_grid', c.itemId);
    }
  }
  // Keep the list order (stacking order) when an existing placement changes.
  let placements: LayoutPlacement[];
  if (prev && c.to) placements = list.map((p, i) => (i === at ? c.to! : p));
  else if (prev) placements = list.filter((_, i) => i !== at);
  else {
    const i = Math.min(Math.max(0, c.index ?? list.length), list.length);
    placements = [...list.slice(0, i), c.to!, ...list.slice(i)];
  }
  return { ok: true, layout: { ...l, placements }, inverse, changed: true };
}

function applyRoomAdd(l: Layout, c: RoomAddCommand): ApplyResult {
  const rooms = l.rooms ?? [];
  const inverse: RoomRemoveCommand = {
    kind: 'room.remove',
    id: c.room.id,
    ...(c.repair ? { repair: true as const } : {}),
  };
  const prev = rooms.find((r) => r.id === c.room.id);
  if (prev) {
    if (prev.name === c.room.name && prev.color === c.room.color)
      return { ok: true, layout: l, inverse, changed: false };
    return fail('room_exists', c.room.id);
  }
  return { ok: true, layout: { ...l, rooms: [...rooms, c.room] }, inverse, changed: true };
}

/** `obj` with `key` set to `value`, or without `key` when `value` is null (absent = none). */
function withOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | null): T {
  const out = { ...obj, [key]: value };
  if (value === null) delete out[key];
  return out;
}

function applyRoomUpdate(l: Layout, c: RoomUpdateCommand): ApplyResult {
  const rooms = l.rooms ?? [];
  const i = rooms.findIndex((r) => r.id === c.id);
  if (i < 0) return fail('room_missing', c.id);
  const prev = rooms[i]!;
  let next = {
    ...prev,
    ...(c.name !== undefined && { name: c.name }),
    ...(c.color !== undefined && { color: c.color }),
  };
  if (c.floor !== undefined) next = withOptional(next, 'floor', c.floor);
  if (c.walls !== undefined) next = withOptional(next, 'walls', c.walls);
  const inverse: RoomUpdateCommand = {
    kind: 'room.update',
    id: c.id,
    ...(c.name !== undefined && { name: prev.name }),
    ...(c.color !== undefined && { color: prev.color }),
    ...(c.floor !== undefined && { floor: prev.floor ?? null }),
    ...(c.walls !== undefined && { walls: prev.walls ?? null }),
  };
  if (
    next.name === prev.name &&
    next.color === prev.color &&
    (next.floor ?? null) === (prev.floor ?? null) &&
    (next.walls ?? null) === (prev.walls ?? null)
  )
    return { ok: true, layout: l, inverse, changed: false };
  return {
    ok: true,
    layout: { ...l, rooms: rooms.map((r, j) => (j === i ? next : r)) },
    inverse,
    changed: true,
  };
}

function applyHouseUpdate(l: Layout, c: HouseUpdateCommand): ApplyResult {
  const inverse: HouseUpdateCommand = {
    kind: 'house.update',
    ...(c.exteriorWallColor !== undefined && { exteriorWallColor: l.exteriorWallColor ?? null }),
  };
  if (c.exteriorWallColor === undefined || (l.exteriorWallColor ?? null) === c.exteriorWallColor)
    return { ok: true, layout: l, inverse, changed: false };
  return {
    ok: true,
    layout: withOptional(l, 'exteriorWallColor', c.exteriorWallColor),
    inverse,
    changed: true,
  };
}

function applyRoomRemove(l: Layout, c: RoomRemoveCommand): ApplyResult {
  const rooms = l.rooms ?? [];
  const prev = rooms.find((r) => r.id === c.id);
  if (!prev) {
    // Already gone: nothing to undo either.
    return { ok: true, layout: l, inverse: { kind: 'batch', commands: [] }, changed: false };
  }
  if (!c.repair && l.floors.some((f) => Object.values(f.cells ?? {}).includes(c.id)))
    return fail('room_in_use', c.id);
  return {
    ok: true,
    layout: { ...l, rooms: rooms.filter((r) => r.id !== c.id) },
    inverse: { kind: 'room.add', room: prev, ...(c.repair ? { repair: true as const } : {}) },
    changed: true,
  };
}

/** What removing a floor takes with it (D35): tiles, placed items in list order, openings. */
export function floorLoss(l: Layout, floorId: string) {
  const floor = l.floors.find((f) => f.id === floorId);
  const placements = (l.placements ?? []).flatMap((placement, index) =>
    placement.floorId === floorId ? [{ index, placement }] : [],
  );
  const openings = (l.openings ?? []).flatMap((opening, index) =>
    opening.floorId === floorId ? [{ index, opening }] : [],
  );
  return { floor, placements, openings, tiles: Object.keys(floor?.cells ?? {}).length };
}

function applyFloorAdd(l: Layout, c: FloorAddCommand, ctx: ApplyContext): ApplyResult {
  const inverse: FloorRemoveCommand = {
    kind: 'floor.remove',
    id: c.floor.id,
    confirmed: {
      tiles: Object.keys(c.floor.cells ?? {}).length,
      items: (c.restore?.placements ?? []).map((p) => p.placement.itemId),
      openings: c.restore?.openings.length ?? 0,
    },
  };
  const prev = l.floors.find((f) => f.id === c.floor.id);
  if (prev) {
    // A save whose response was lost: already there, nothing to do.
    if (JSON.stringify(prev) === JSON.stringify(c.floor))
      return { ok: true, layout: l, inverse, changed: false };
    return fail('floor_exists', c.floor.id);
  }
  const floors = [...l.floors];
  floors.splice(Math.min(Math.max(0, c.index ?? floors.length), floors.length), 0, c.floor);
  let placements = l.placements ?? [];
  let openings = l.openings ?? [];
  if (c.restore) {
    placements = [...placements];
    for (const { index, placement } of [...c.restore.placements].sort(
      (a, b) => a.index - b.index,
    )) {
      if (placements.some((p) => p.itemId === placement.itemId))
        return fail('already_placed', placement.itemId);
      if (ctx.noteDeleted?.(placement.itemId)) return fail('note_deleted', placement.itemId);
      placements.splice(Math.min(index, placements.length), 0, placement);
    }
    openings = [...openings];
    for (const { index, opening } of [...c.restore.openings].sort((a, b) => a.index - b.index))
      if (!openings.some((o) => openingKey(o) === openingKey(opening)))
        openings.splice(Math.min(index, openings.length), 0, opening);
  }
  return { ok: true, layout: { ...l, floors, placements, openings }, inverse, changed: true };
}

function applyFloorUpdate(l: Layout, c: FloorUpdateCommand): ApplyResult {
  const i = l.floors.findIndex((f) => f.id === c.id);
  if (i < 0) return fail('floor_missing', c.id);
  const prev = l.floors[i]!;
  const next = {
    ...prev,
    ...(c.name !== undefined && { name: c.name }),
    ...(c.level !== undefined && { level: c.level }),
  };
  const inverse: FloorUpdateCommand = {
    kind: 'floor.update',
    id: c.id,
    ...(c.name !== undefined && { name: prev.name }),
    ...(c.level !== undefined && { level: prev.level }),
  };
  if (next.name === prev.name && next.level === prev.level)
    return { ok: true, layout: l, inverse, changed: false };
  return {
    ok: true,
    layout: { ...l, floors: l.floors.map((f, j) => (j === i ? next : f)) },
    inverse,
    changed: true,
  };
}

function applyFloorRemove(l: Layout, c: FloorRemoveCommand): ApplyResult {
  const index = l.floors.findIndex((f) => f.id === c.id);
  if (index < 0)
    return { ok: true, layout: l, inverse: { kind: 'batch', commands: [] }, changed: false };
  if (l.floors.length === 1) return fail('last_floor', c.id);
  const loss = floorLoss(l, c.id);
  const confirmedItems = new Set(c.confirmed.items);
  if (
    loss.tiles > c.confirmed.tiles ||
    loss.openings.length > c.confirmed.openings ||
    loss.placements.some((p) => !confirmedItems.has(p.placement.itemId))
  )
    return fail('more_lost');
  return {
    ok: true,
    layout: {
      ...l,
      floors: l.floors.filter((f) => f.id !== c.id),
      placements: (l.placements ?? []).filter((p) => p.floorId !== c.id),
      openings: (l.openings ?? []).filter((o) => o.floorId !== c.id),
    },
    inverse: {
      kind: 'floor.add',
      floor: loss.floor!,
      index,
      restore: { placements: loss.placements, openings: loss.openings },
    },
    changed: true,
  };
}

function applyOpenings(l: Layout, c: OpeningsCommand): ApplyResult {
  const byKey = new Map((l.openings ?? []).map((o) => [openingKey(o), o]));
  const before = new Map(byKey);
  for (const o of c.remove) byKey.delete(openingKey(o));
  for (const o of c.add) {
    if (c.repair) {
      byKey.set(openingKey(o), o);
      continue;
    }
    if (!l.floors.some((f) => f.id === o.floorId)) return fail('floor_missing', o.floorId);
    const fits =
      o.x >= 0 &&
      o.y >= 0 &&
      (o.side === 'n'
        ? o.x < l.grid.width && o.y <= l.grid.depth
        : o.x <= l.grid.width && o.y < l.grid.depth);
    if (!fits) return fail('outside_grid');
    byKey.set(openingKey(o), o);
  }
  // The inverse restores exactly the edges this command touched.
  const touched = new Set([...c.remove, ...c.add].map(openingKey));
  const oldIndex = new Map((l.openings ?? []).map((o, i) => [openingKey(o), i]));
  const inverse: OpeningsCommand = {
    kind: 'openings',
    add: [],
    remove: [],
    addAt: [],
    ...(c.repair ? { repair: true as const } : {}),
  };
  let changed = false;
  for (const key of touched) {
    const was = before.get(key);
    const now = byKey.get(key);
    if (was?.kind === now?.kind) continue;
    changed = true;
    if (now) inverse.remove.push(now);
    if (was) {
      inverse.add.push(was);
      inverse.addAt!.push(oldIndex.get(key)!);
    }
  }
  if (!changed) return { ok: true, layout: l, inverse, changed: false };
  // Keep the original order; replaced edges stay where they were, new ones go to `addAt`
  // (ascending, so earlier insertions don't move later ones), else to the end.
  const openings = (l.openings ?? []).flatMap((o) => {
    const now = byKey.get(openingKey(o));
    return now ? [now] : [];
  });
  const fresh = c.add
    .map((o, i) => ({ o, at: c.addAt?.[i] ?? Infinity }))
    .filter(({ o }) => !before.has(openingKey(o)))
    .sort((a, b) => a.at - b.at);
  for (const { o, at } of fresh) openings.splice(Math.min(at, openings.length), 0, o);
  return { ok: true, layout: { ...l, openings }, inverse, changed: true };
}

/** Commands that put back what a resize cut, moved by (dx, dy) into the original grid. */
function restoreCommands(loss: ResizeLoss, original: Layout, dx: number, dy: number): Command[] {
  const out: Command[] = [];
  const cellsByFloor = new Map<string, CellsCommand['set']>();
  for (const cell of loss.cells) {
    const list = cellsByFloor.get(cell.floorId) ?? [];
    list.push([cell.x + dx, cell.y + dy, cell.roomId]);
    cellsByFloor.set(cell.floorId, list);
  }
  for (const [floorId, set] of cellsByFloor)
    out.push({ kind: 'cells', floorId, set, repair: true });
  // Back at their old places in the list (ascending), so the stacking order survives undo.
  const order = new Map((original.placements ?? []).map((p, i) => [p.itemId, i]));
  for (const p of loss.placements)
    out.push({
      kind: 'placement',
      itemId: p.itemId,
      to: { ...p, x: p.x + dx, y: p.y + dy },
      requires: 'unplaced',
      index: order.get(p.itemId) ?? 0,
      repair: true,
    });
  if (loss.openings.length) {
    const at = new Map((original.openings ?? []).map((o, i) => [openingKey(o), i]));
    const add = loss.openings.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
    out.push({
      kind: 'openings',
      add,
      remove: [],
      addAt: add.map((o) => at.get(openingKey(o)) ?? Infinity),
      repair: true,
    });
  }
  return out;
}

function applyResize(l: Layout, c: ResizeCommand, ctx: ApplyContext): ApplyResult {
  const target = resizedSize(c.from, c.by);
  const { width, depth } = l.grid;
  if (width !== c.from.width || depth !== c.from.depth) {
    // Already resized (a save whose response was lost): nothing left to do.
    if (width === target.width && depth === target.depth)
      return { ok: true, layout: l, inverse: { kind: 'batch', commands: [] }, changed: false };
    return fail('grid_changed');
  }
  if (!sizeAllowed(target)) return fail('size_invalid');
  const { layout, loss } = resizeLayout(l, c.by, ctx.footprintOf);
  const allowed = new Set(c.allowLoss);
  if (lossKeys(loss).some((k) => !allowed.has(k))) return fail('more_lost');
  const back: ResizeCommand = {
    kind: 'resize',
    from: target,
    by: { n: -c.by.n, e: -c.by.e, s: -c.by.s, w: -c.by.w },
    allowLoss: [],
  };
  // Undo resizes back and puts back exactly what was there: what this resize cut, and what was
  // outside the grid before and is inside now (D30 repairs), which resizing back cuts again.
  // Repair commands, since that content may be outside the grid or point to a missing room.
  const backLoss = resizeLayout(layout, back.by, ctx.footprintOf).loss;
  back.allowLoss = lossKeys(backLoss);
  const restore = [
    ...restoreCommands(loss, l, 0, 0),
    ...restoreCommands(backLoss, l, -c.by.w, -c.by.n),
  ];
  const changed = c.by.n !== 0 || c.by.e !== 0 || c.by.s !== 0 || c.by.w !== 0;
  return {
    ok: true,
    layout: changed ? layout : l,
    inverse: { kind: 'batch', commands: [back, ...restore] },
    changed,
  };
}

function applyDedupe(l: Layout, c: DedupeCommand): ApplyResult {
  const list = l.placements ?? [];
  if (c.restore?.length) {
    const placements = [...list];
    for (const r of [...c.restore].sort((a, b) => a.index - b.index))
      placements.splice(Math.min(r.index, placements.length), 0, r.placement);
    return {
      ok: true,
      layout: { ...l, placements },
      inverse: { kind: 'dedupe', itemId: c.itemId },
      changed: true,
    };
  }
  const first = list.findIndex((p) => p.itemId === c.itemId);
  const removed = list
    .map((placement, index) => ({ index, placement }))
    .filter(({ placement, index }) => placement.itemId === c.itemId && index !== first);
  const inverse: DedupeCommand = { kind: 'dedupe', itemId: c.itemId, restore: removed };
  if (!removed.length) return { ok: true, layout: l, inverse, changed: false };
  const gone = new Set(removed.map((r) => r.index));
  return {
    ok: true,
    layout: { ...l, placements: list.filter((_, i) => !gone.has(i)) },
    inverse,
    changed: true,
  };
}

function applyBatch(l: Layout, c: BatchCommand, ctx: ApplyContext): ApplyResult {
  let layout = l;
  let changed = false;
  const inverses: Command[] = [];
  for (const sub of c.commands) {
    const r = applyCommand(layout, sub, ctx);
    if (!r.ok) return r;
    layout = r.layout;
    changed ||= r.changed;
    inverses.unshift(r.inverse);
  }
  return { ok: true, layout, inverse: { kind: 'batch', commands: inverses }, changed };
}

/** Apply one command to a layout. Never mutates `layout`. */
export function applyCommand(layout: Layout, cmd: Command, ctx: ApplyContext): ApplyResult {
  switch (cmd.kind) {
    case 'cells':
      return applyCells(layout, cmd);
    case 'placement':
      return applyPlacement(layout, cmd, ctx);
    case 'floor.add':
      return applyFloorAdd(layout, cmd, ctx);
    case 'floor.update':
      return applyFloorUpdate(layout, cmd);
    case 'floor.remove':
      return applyFloorRemove(layout, cmd);
    case 'room.add':
      return applyRoomAdd(layout, cmd);
    case 'room.update':
      return applyRoomUpdate(layout, cmd);
    case 'room.remove':
      return applyRoomRemove(layout, cmd);
    case 'house.update':
      return applyHouseUpdate(layout, cmd);
    case 'openings':
      return applyOpenings(layout, cmd);
    case 'resize':
      return applyResize(layout, cmd, ctx);
    case 'dedupe':
      return applyDedupe(layout, cmd);
    case 'batch':
      return applyBatch(layout, cmd, ctx);
  }
}

// ---- builders ---------------------------------------------------------------------------------

/** Paint (roomId) or erase (null) every tile of a list, as one command. */
export const setCells = (floorId: string, cells: readonly Cell[], roomId: string | null) =>
  ({ kind: 'cells', floorId, set: cells.map((c) => [c.x, c.y, roomId]) }) satisfies CellsCommand;

// ---- frames (M5-02) ------------------------------------------------------------------------

/**
 * The same command in a grid whose origin moved by (dx, dy) tiles: another writer grew (or
 * shrank) the house on the north or west side. Coordinates move; a resize keeps its `from`
 * (it was made for a size the grid no longer has, so it conflicts with `grid_changed`).
 */
export function shiftCommand(cmd: Command, dx: number, dy: number): Command {
  if (dx === 0 && dy === 0) return cmd;
  switch (cmd.kind) {
    case 'cells':
      return { ...cmd, set: cmd.set.map(([x, y, r]) => [x + dx, y + dy, r]) };
    case 'placement':
      return cmd.to ? { ...cmd, to: { ...cmd.to, x: cmd.to.x + dx, y: cmd.to.y + dy } } : cmd;
    case 'openings': {
      const move = (o: LayoutOpening) => ({ ...o, x: o.x + dx, y: o.y + dy });
      return { ...cmd, add: cmd.add.map(move), remove: cmd.remove.map(move) };
    }
    case 'batch':
      return { ...cmd, commands: cmd.commands.map((c) => shiftCommand(c, dx, dy)) };
    case 'floor.add': {
      const cells: Record<string, string> = {};
      for (const [key, room] of Object.entries(cmd.floor.cells ?? {})) {
        const c = parseCellKey(key);
        if (c) cells[cellKey(c.x + dx, c.y + dy)] = room;
      }
      return {
        ...cmd,
        floor: { ...cmd.floor, cells },
        ...(cmd.restore && {
          restore: {
            placements: cmd.restore.placements.map((r) => ({
              ...r,
              placement: { ...r.placement, x: r.placement.x + dx, y: r.placement.y + dy },
            })),
            openings: cmd.restore.openings.map((r) => ({
              ...r,
              opening: { ...r.opening, x: r.opening.x + dx, y: r.opening.y + dy },
            })),
          },
        }),
      };
    }
    case 'dedupe':
      return cmd.restore
        ? {
            ...cmd,
            restore: cmd.restore.map((r) => ({
              ...r,
              placement: { ...r.placement, x: r.placement.x + dx, y: r.placement.y + dy },
            })),
          }
        : cmd;
    default:
      return cmd;
  }
}
