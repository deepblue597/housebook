/**
 * Replay on 412 (DESIGN 15.2): re-apply the pending (applied locally, not yet saved) commands on
 * top of a fresh layout from the server. Commands that no longer apply are dropped and reported;
 * the rest get new inverses computed against the fresh layout, so undo stays exact.
 */
import type { Layout } from '../domain/layout';
import { type ApplyContext, type Command, type Conflict, applyCommand } from './commands';

/** One command applied locally: a new edit or redo (`do`), or an undo (`undo`). */
export interface Applied {
  /** The history entry it belongs to. */
  entryId: number;
  dir: 'do' | 'undo';
  cmd: Command;
}

export interface ReplayResult {
  layout: Layout;
  /** Commands that still applied, with their inverse on the new layout. `changed: false`
   *  means the effect was already there (e.g. the save went through but its response was lost):
   *  the inverse is then empty, and the caller keeps the one it had (M5-01). */
  kept: { rec: Applied; inverse: Command; changed: boolean }[];
  /**
   * Commands that didn't. Once an entry's command is dropped, later commands of the same entry
   * (its undo, its redo) are dropped too, without a conflict of their own (`conflict: null`);
   * after a dropped resize, every later command is (its coordinates are in the lost grid).
   */
  dropped: { rec: Applied; conflict: Conflict | null }[];
}

export function replay(base: Layout, recs: readonly Applied[], ctx: ApplyContext): ReplayResult {
  let layout = base;
  const kept: ReplayResult['kept'] = [];
  const dropped: ReplayResult['dropped'] = [];
  const gone = new Set<number>();
  let frameLost = false;
  for (const rec of recs) {
    if (gone.has(rec.entryId) || frameLost) {
      dropped.push({ rec, conflict: null });
      continue;
    }
    const r = applyCommand(layout, rec.cmd, ctx);
    if (r.ok) {
      layout = r.layout;
      kept.push({ rec, inverse: r.inverse, changed: r.changed });
    } else {
      gone.add(rec.entryId);
      dropped.push({ rec, conflict: r.conflict });
      // Everything after a dropped resize was made in a grid that never existed here.
      if (rec.cmd.kind === 'resize') frameLost = true;
    }
  }
  return { layout, kept, dropped };
}
