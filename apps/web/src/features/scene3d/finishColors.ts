/**
 * Surfaces of the home look (D41, D42): a room's floor, what each side of a wall shows, and wall
 * halves grouped so that each surface is one mesh. A surface is a colour, plus a texture for
 * floor finishes and wallpapers (the colour is drawn while it loads). Pure, tested without WebGL.
 */
import type { OwnTexture, Room } from '../../api/types';
import {
  EXTERIOR_DEFAULT,
  type FinishTexture,
  finishTexture,
  floorFinish,
  paintPalette,
  wallFinish,
} from '../../catalog/finishes';
import { type Box, OUTSIDE } from '../../domain/scene';

/** Walls of a room without a wall finish: the first paint (white), not the plan's grey. */
export const UNPAINTED = paintPalette()[0]!.color;

export interface Surface {
  /** Same key, same mesh: a colour, or a wallpaper or floor key. */
  key: string;
  color: string;
  texture?: FinishTexture;
}

const paint = (color: string): Surface => ({ key: color.toLowerCase(), color });

/** What each wall half shows, by its `side` (a room id or OUTSIDE). */
export function wallSideSurfaces(
  rooms: readonly Pick<Room, 'id' | 'walls'>[],
  exteriorWallColor: string | null | undefined,
  own?: readonly OwnTexture[],
): (side: string | undefined) => Surface {
  const byRoom = new Map(rooms.map((r) => [r.id, r]));
  const outside = paint(exteriorWallColor || EXTERIOR_DEFAULT);
  return (side) => {
    if (side === OUTSIDE || side === undefined) return outside;
    const w = wallFinish(byRoom.get(side)?.walls, own);
    if (!w) return paint(UNPAINTED);
    if (w.kind === 'paint') return paint(w.color);
    return {
      key: `wallpaper:${w.finish.key}`,
      color: w.finish.color,
      texture: finishTexture(w.finish),
    };
  };
}

/** A room's floor in the home look, or undefined (drawn in its plan colour). */
export function floorSurface(
  room: Pick<Room, 'floor'> | undefined,
  own?: readonly OwnTexture[],
): Surface | undefined {
  const f = floorFinish(room?.floor, own);
  return f && { key: `floor:${f.key}`, color: f.color, texture: finishTexture(f) };
}

/** Boxes grouped by surface, in a stable order (one mesh per surface). */
export function groupBySurface(
  boxes: readonly Box[],
  surfaceOf: (side: string | undefined) => Surface,
): { surface: Surface; boxes: Box[] }[] {
  const groups = new Map<string, { surface: Surface; boxes: Box[] }>();
  for (const b of boxes) {
    const s = surfaceOf(b.side);
    let g = groups.get(s.key);
    if (!g) groups.set(s.key, (g = { surface: s, boxes: [] }));
    g.boxes.push(b);
  }
  return [...groups.values()].sort((a, b) => a.surface.key.localeCompare(b.surface.key));
}
