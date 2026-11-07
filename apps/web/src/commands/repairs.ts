/**
 * Repairs for problems found in the layout (D30): each fix of a `LayoutIssue` as one ordinary
 * command, so undo, autosave and replay treat it like any other edit. Pure.
 */
import {
  type IssueCell,
  type Layout,
  type LayoutIssue,
  type LayoutOpening,
  type LayoutPlacement,
  type LayoutRoom,
  isValidId,
} from '../domain/layout';
import type { CellsCommand, Command } from './commands';

export type RepairFix =
  | 'recreate_room'
  | 'erase_tiles'
  | 'keep_first'
  | 'grow'
  | 'remove_outside'
  | 'remove_unknown_floor';

/** The fixes offered for an issue, in button order. */
export function repairFixes(issue: LayoutIssue): RepairFix[] {
  switch (issue.kind) {
    case 'unknown_room':
      return ['recreate_room', 'erase_tiles'];
    case 'duplicate_placement':
      return ['keep_first'];
    case 'outside_grid':
      return issue.fit ? ['grow', 'remove_outside'] : ['remove_outside'];
    case 'unknown_floor':
      return ['remove_unknown_floor'];
  }
}

/** Erase tiles, one `cells` command per floor (repair: they may be outside the grid). */
function eraseCells(cells: readonly IssueCell[]): Command[] {
  const byFloor = new Map<string, CellsCommand['set']>();
  for (const c of cells) {
    const list = byFloor.get(c.floorId) ?? [];
    list.push([c.x, c.y, null]);
    byFloor.set(c.floorId, list);
  }
  return [...byFloor].map(([floorId, set]) => ({ kind: 'cells', floorId, set, repair: true }));
}

/** Remove exactly these placements (not just "the item's placement", M5-09) and openings. */
function removeAll(placements: readonly LayoutPlacement[], openings: LayoutOpening[]): Command[] {
  const out: Command[] = placements.map((p) => ({
    kind: 'placement',
    itemId: p.itemId,
    to: null,
    requires: 'placed',
    match: p,
    repair: true,
  }));
  if (openings?.length) out.push({ kind: 'openings', add: [], remove: openings, repair: true });
  return out;
}

/**
 * The command for one fix. `room` is the room to create for `recreate_room`: the missing id,
 * or, when that isn't a valid id (a room name typed by hand, M5-08), `room.id` (the caller
 * picks a free one) with the tiles moved over to it; nothing is lost either way.
 */
export function repairCommand(
  layout: Layout,
  issue: LayoutIssue,
  fix: RepairFix,
  room?: LayoutRoom,
): Command | null {
  switch (fix) {
    case 'recreate_room': {
      if (issue.kind !== 'unknown_room' || !room) return null;
      if (isValidId(issue.roomId))
        return { kind: 'room.add', room: { ...room, id: issue.roomId }, repair: true };
      const byFloor = new Map<string, CellsCommand['set']>();
      for (const c of issue.cells) {
        const list = byFloor.get(c.floorId) ?? [];
        list.push([c.x, c.y, room.id]);
        byFloor.set(c.floorId, list);
      }
      return {
        kind: 'batch',
        commands: [
          { kind: 'room.add', room },
          ...[...byFloor].map(([floorId, set]): Command => ({
            kind: 'cells',
            floorId,
            set,
            repair: true,
          })),
        ],
      };
    }
    case 'erase_tiles':
      return issue.kind === 'unknown_room'
        ? { kind: 'batch', commands: eraseCells(issue.cells) }
        : null;
    case 'keep_first':
      return issue.kind === 'duplicate_placement' ? { kind: 'dedupe', itemId: issue.itemId } : null;
    case 'grow': {
      if (issue.kind !== 'outside_grid' || !issue.fit) return null;
      const { width, depth } = layout.grid;
      return {
        kind: 'resize',
        from: { width, depth },
        by: { n: 0, w: 0, e: issue.fit.width - width, s: issue.fit.depth - depth },
        allowLoss: [],
      };
    }
    case 'remove_outside':
      return issue.kind === 'outside_grid'
        ? {
            kind: 'batch',
            commands: [...eraseCells(issue.cells), ...removeAll(issue.placements, issue.openings)],
          }
        : null;
    case 'remove_unknown_floor':
      return issue.kind === 'unknown_floor'
        ? { kind: 'batch', commands: removeAll(issue.placements, issue.openings) }
        : null;
  }
}
