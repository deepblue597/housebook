/**
 * examples/house as a snapshot for scene tests: the real house.json (rooms, two floors,
 * openings, placements) with stand-in items of the same ids and types as its notes.
 */
import houseRaw from '../../../../examples/house/house.json?raw';
import type { House, Item, Snapshot } from '../api/types';
import { makeItem } from './fixtures';

export const house = JSON.parse(houseRaw) as House;

/** id → [type, name], from examples/house notes. */
export const EXAMPLE_ITEMS: Record<string, [string, string]> = {
  it_9b3m7x: ['oven', 'Oven'],
  it_2c6p1d: ['microwave', 'Microwave'],
  it_4f8k2q: ['fridge', 'Fridge'],
  it_7n3d8f: ['fuse', 'Fuse box'],
  it_2v9q6t: ['valve', 'Main water valve'],
  it_0k5s2m: ['washer', 'Washing machine'],
  it_7f3k2a: ['dishwasher', 'Dishwasher'],
  it_8r2w6z: ['router', 'Router'],
  it_6h4j9b: ['ac', 'Bedroom AC'],
  it_5t1v8n: ['tv', 'TV'],
  it_9p2x5c: ['fridge', 'Chest freezer'],
  it_3a9c4l: ['ac', 'Living room AC'],
  it_1w7e3h: ['heater', 'Water heater'],
  it_4g6y1r: ['smoke', 'Smoke detector'],
};

const overdue: Item['status'] = {
  level: 'overdue',
  check: { state: 'overdue', date: '2026-10-01', days: -34, derived: false },
  warranty: null,
};

export function exampleSnapshot(): Snapshot {
  const items = (house.placements ?? []).map((p): Item => {
    const [type, name] = EXAMPLE_ITEMS[p.itemId]!;
    return makeItem({
      id: p.itemId,
      name,
      type,
      location: { floorId: p.floorId, roomId: null, x: p.x, y: p.y, rotation: p.rotation },
      status: p.itemId === 'it_4g6y1r' ? overdue : undefined,
    });
  });
  return {
    today: '2026-11-04',
    timezone: 'UTC',
    houseEtag: 'h',
    houseReadOnly: false,
    houseSchemaVersion: 1,
    problemCount: 0,
    itemsVersion: 'v',
    textures: [],
    texturesVersion: 't',
    house,
    items,
  };
}
