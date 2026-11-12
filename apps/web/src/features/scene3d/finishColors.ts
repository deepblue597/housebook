/**
 * Colours of the home look (D41), flat for now: a room's floor finish, what each side of a wall
 * shows, and wall halves grouped so that each colour is one mesh. Pure, tested without WebGL.
 */
import type { Room } from '../../api/types';
import {
  EXTERIOR_DEFAULT,
  floorFinish,
  paintPalette,
  wallFinish,
  wallFinishColor,
} from '../../catalog/finishes';
import { type Box, OUTSIDE } from '../../domain/scene';

/** Walls of a room without a wall finish: the first paint (white), not the plan's grey. */
export const UNPAINTED = paintPalette()[0]!.color;

/** The colour each wall half is drawn with, by its `side` (a room id or OUTSIDE). */
export function wallSideColors(
  rooms: readonly Pick<Room, 'id' | 'walls'>[],
  exteriorWallColor: string | null | undefined,
): (side: string | undefined) => string {
  const byRoom = new Map(rooms.map((r) => [r.id, r]));
  const outside = exteriorWallColor || EXTERIOR_DEFAULT;
  return (side) => {
    if (side === OUTSIDE || side === undefined) return outside;
    const w = wallFinish(byRoom.get(side)?.walls);
    return w ? wallFinishColor(w) : UNPAINTED;
  };
}

/** A room's floor in the home look: its finish, or undefined (drawn in its plan colour). */
export const floorColor = (room: Pick<Room, 'floor'> | undefined): string | undefined =>
  floorFinish(room?.floor)?.color;

/** Boxes grouped by the colour of their side, in a stable order (one mesh per colour). */
export function groupByColor(
  boxes: readonly Box[],
  colorOf: (side: string | undefined) => string,
): { color: string; boxes: Box[] }[] {
  const groups = new Map<string, Box[]>();
  for (const b of boxes) {
    const c = colorOf(b.side).toLowerCase();
    let list = groups.get(c);
    if (!list) groups.set(c, (list = []));
    list.push(b);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([color, bs]) => ({ color, boxes: bs }));
}
