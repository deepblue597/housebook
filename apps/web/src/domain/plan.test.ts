import { describe, expect, it } from 'vitest';
import { cellKey } from './coords';
import {
  area,
  floorCells,
  formatArea,
  labelPosition,
  mergeSegments,
  roomTiles,
  walls,
} from './plan';

const grid = { width: 4, depth: 3 };
// A A B
// A A B
const cells = floorCells(
  {
    '0,0': 'a',
    '1,0': 'a',
    '2,0': 'b',
    '0,1': 'a',
    '1,1': 'a',
    '2,1': 'b',
    '9,9': 'a',
    '3,0': 'ghost',
  },
  grid,
  new Set(['a', 'b']),
);

describe('floorCells', () => {
  it('drops cells outside the grid and cells of unknown rooms', () => {
    expect([...cells.keys()].sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
  });
});

describe('walls', () => {
  const w = walls(cells);
  it('draws one merged interior wall between two rooms', () => {
    expect(w.interior).toEqual([{ x1: 2, y1: 0, x2: 2, y2: 2 }]);
  });
  it('merges the exterior outline into straight runs', () => {
    expect(w.exterior).toEqual(
      expect.arrayContaining([
        { x1: 0, y1: 0, x2: 3, y2: 0 },
        { x1: 0, y1: 2, x2: 3, y2: 2 },
        { x1: 0, y1: 0, x2: 0, y2: 2 },
        { x1: 3, y1: 0, x2: 3, y2: 2 },
      ]),
    );
    expect(w.exterior).toHaveLength(4);
  });
  it('mergeSegments keeps gaps', () => {
    expect(
      mergeSegments([
        { x1: 0, y1: 0, x2: 1, y2: 0 },
        { x1: 2, y1: 0, x2: 3, y2: 0 },
      ]),
    ).toHaveLength(2);
  });
});

describe('rooms', () => {
  it('groups tiles and computes areas with the tile size', () => {
    const tiles = roomTiles(cells);
    expect(tiles.get('a')).toHaveLength(4);
    expect(area(4, 1)).toBe(4);
    expect(formatArea(area(3, 0.5))).toBe('0.8 m²');
    expect(formatArea(16)).toBe('16 m²');
  });

  it('puts the label on the centroid when it is free', () => {
    const tiles = roomTiles(cells).get('a')!;
    expect(labelPosition(tiles, cells, new Set())).toEqual({ x: 1, y: 1 });
  });

  it('moves the label to the nearest free tile when an item covers the centroid', () => {
    const tiles = roomTiles(cells).get('a')!;
    const pos = labelPosition(tiles, cells, new Set([cellKey(0, 0), cellKey(1, 1)]));
    expect([cellKey(pos.x - 0.5, pos.y - 0.5)]).not.toContain(cellKey(0, 0));
    expect(cells.get(cellKey(pos.x - 0.5, pos.y - 0.5))).toBe('a');
  });
});
