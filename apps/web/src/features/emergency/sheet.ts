/**
 * The printable emergency sheet (DESIGN 15.11, D44): which items it shows, how they are
 * numbered, and a fingerprint of everything printed, so the app can tell when a printed copy is
 * out of date. Pure; the page (EmergencySheet.tsx) only draws this.
 *
 * Items: every item whose `critical` is true (the note's `critical`, else the catalogue default:
 * water and gas valves, fuse box, boiler, router). Numbered 1…n floor by floor in the app's
 * floor order, then in reading order on the plan (top to bottom, left to right), so the markers
 * are easy to find; unplaced ones come last.
 */
import type { Item } from '../../api/types';
import { typeLabel } from '../../catalog/catalog';
import { type Rect, cellKey } from '../../domain/coords';
import { sectionLines, withoutSection } from '../../domain/notes';
import { openingsOnWalls } from '../../domain/plan';
import { type FloorModel, type Model, itemRect, roomOf } from '../../store/model';

export interface SheetItem {
  /** Marker number on the plan and in the list. */
  n: number;
  item: Item;
  typeLabel: string;
  room: string | null;
  floor: string | null;
  /** Tiles it occupies on its floor; null when unplaced. */
  rect: Rect | null;
  /** What to do, as Markdown (see `helpOf`), or ''. */
  help: string;
}

export interface SheetFloor {
  floor: FloorModel;
  /** The part of the grid the floor uses (its rooms' tiles), in tiles. */
  bounds: Rect;
  items: SheetItem[];
}

export interface Sheet {
  /** Floors with at least one emergency item. */
  floors: SheetFloor[];
  /** Emergency items not on the plan. */
  unplaced: SheetItem[];
  count: number;
}

/**
 * What the sheet prints from a note: its "Quick help" section when it has one, else the whole
 * note without its maintenance log (emergency notes are short, and a fuse box's circuit list or
 * a valve's "turn clockwise" is exactly what is needed). A Quick help section keeps a long note
 * short on paper.
 */
export function helpOf(body: string): string {
  const quick = sectionLines(body, 'Quick help').join('\n').trim();
  return quick || withoutSection(body, 'Maintenance log').trim();
}

/** Bounding box of a floor's room tiles; the whole grid when it has none. */
export function floorBounds(f: FloorModel, grid: { width: number; depth: number }): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of f.cells.keys()) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (minX === Infinity) return { x: 0, y: 0, w: grid.width, h: grid.depth };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function emergencySheet(model: Model): Sheet {
  let n = 0;
  const entry = (item: Item, floor: FloorModel | null): SheetItem => ({
    n: ++n,
    item,
    typeLabel: typeLabel(item.type),
    room: roomOf(model, item)?.name ?? null,
    floor: floor?.floor.name ?? null,
    rect: floor ? itemRect(model, item) : null,
    help: helpOf(item.body),
  });

  const floors: SheetFloor[] = [];
  for (const f of model.floors) {
    const critical = f.items
      .filter((i) => i.critical)
      .map((i) => ({ i, r: itemRect(model, i) }))
      .sort(
        (a, b) =>
          (a.r?.y ?? 0) - (b.r?.y ?? 0) ||
          (a.r?.x ?? 0) - (b.r?.x ?? 0) ||
          a.i.name.localeCompare(b.i.name),
      );
    if (critical.length === 0) continue;
    floors.push({
      floor: f,
      bounds: floorBounds(f, model.grid),
      items: critical.map(({ i }) => entry(i, f)),
    });
  }
  const unplaced = model.unplaced.filter((i) => i.critical).map((i) => entry(i, null));
  return { floors, unplaced, count: n };
}

/** 32-bit FNV-1a, as 8 hex digits: short enough to print on the sheet. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A fingerprint of what the sheet shows: the plans of its floors (rooms, walls, doors and
 * windows) and every item's number, name, place and quick help. Anything else (other items,
 * statuses, dates) can change without making a printed copy wrong.
 */
export function sheetFingerprint(model: Model, sheet: Sheet): string {
  const openings = model.snapshot.house?.openings ?? [];
  const floors = sheet.floors.map((f) => {
    const cells = [...f.floor.cells].sort(([a], [b]) => a.localeCompare(b));
    const rooms = [...new Set(f.floor.cells.values())]
      .sort()
      .map((id) => [id, model.rooms.get(id)?.name ?? '']);
    const doors = openingsOnWalls(
      openings.filter((o) => o.floorId === f.floor.floor.id),
      f.floor.cells,
    )
      .map((o) => [o.x, o.y, o.side, o.kind])
      .sort((a, b) => String(a).localeCompare(String(b)));
    return [f.floor.floor.name, cells, rooms, doors];
  });
  const items = [...sheet.floors.flatMap((f) => f.items), ...sheet.unplaced].map((s) => [
    s.n,
    s.item.name,
    s.typeLabel,
    s.room,
    s.floor,
    s.rect && cellKey(s.rect.x, s.rect.y),
    s.rect && [s.rect.w, s.rect.h],
    s.item.fields.brand ?? null,
    s.item.fields.model ?? null,
    s.item.fields.support ?? null,
    s.help,
  ]);
  return fnv1a(JSON.stringify([model.tileSize, floors, items]));
}
