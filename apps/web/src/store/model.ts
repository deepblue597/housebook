/**
 * The read model the views render from: the snapshot plus lookups derived once per snapshot
 * (rooms by id, items per floor, valid cells per floor, search documents).
 */
import type { Floor, Item, Room, Snapshot } from '../api/types';
import { typeLabel } from '../catalog/catalog';
import { cellKey } from '../domain/coords';
import { type CellMap, area, floorCells, roomTiles } from '../domain/plan';
import { type SearchDoc, toSearchDoc } from '../domain/search';

export interface FloorModel {
  floor: Floor;
  cells: CellMap;
  /** Room id -> area in m² on this floor. */
  roomAreas: Map<string, number>;
  /** Items placed on this floor, by name. */
  items: Item[];
}

export interface Model {
  snapshot: Snapshot;
  tileSize: number;
  grid: { width: number; depth: number };
  rooms: Map<string, Room>;
  /** Highest level first, like a building section. */
  floors: FloorModel[];
  floorById: Map<string, FloorModel>;
  items: Map<string, Item>;
  /** Notes with no placement, or placed on a floor that no longer exists. */
  unplaced: Item[];
  searchDocs: SearchDoc[];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function buildModel(snapshot: Snapshot): Model {
  const house = snapshot.house;
  const tileSize = house?.grid.tileSize ?? 1;
  const grid = { width: house?.grid.width ?? 0, depth: house?.grid.depth ?? 0 };
  const rooms = new Map((house?.rooms ?? []).map((r) => [r.id, r]));
  const roomIds = new Set(rooms.keys());
  const items = new Map(snapshot.items.map((i) => [i.id, i]));

  const floors = [...(house?.floors ?? [])]
    .sort((a, b) => b.level - a.level)
    .map((floor): FloorModel => {
      const cells = floorCells(floor.cells, grid, roomIds);
      const roomAreas = new Map(
        [...roomTiles(cells)].map(([id, tiles]) => [id, area(tiles.length, tileSize)]),
      );
      return { floor, cells, roomAreas, items: [] };
    });
  const floorById = new Map(floors.map((f) => [f.floor.id, f]));

  const unplaced: Item[] = [];
  for (const item of [...snapshot.items].sort(byName)) {
    const f = item.location ? floorById.get(item.location.floorId) : undefined;
    if (f) f.items.push(item);
    else unplaced.push(item);
  }

  const searchDocs = snapshot.items.map((i) =>
    toSearchDoc({
      id: i.id,
      name: i.name,
      errorCodes: i.errorCodes,
      model: i.fields.model ?? '',
      brand: i.fields.brand ?? '',
      serial: i.fields.serial ?? '',
      typeLabel: i.type ? typeLabel(i.type) : '',
      room: roomOf({ rooms }, i)?.name ?? '',
      body: i.body,
    }),
  );

  return { snapshot, tileSize, grid, rooms, floors, floorById, items, unplaced, searchDocs };
}

/** The item's room, derived from the tile it stands on (never stored). */
export const roomOf = (m: Pick<Model, 'rooms'>, item: Item): Room | undefined =>
  item.location?.roomId ? m.rooms.get(item.location.roomId) : undefined;

export const floorOf = (m: Model, item: Item): FloorModel | undefined =>
  item.location ? m.floorById.get(item.location.floorId) : undefined;

/** Items on a floor whose tile belongs to a room. */
export const itemsInRoom = (f: FloorModel, roomId: string): Item[] =>
  f.items.filter((i) => i.location && f.cells.get(cellKey(i.location.x, i.location.y)) === roomId);
