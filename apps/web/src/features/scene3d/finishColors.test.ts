import { describe, expect, it } from 'vitest';
import { EXTERIOR_DEFAULT } from '../../catalog/finishes';
import { OUTSIDE } from '../../domain/scene';
import { UNPAINTED, floorColor, groupByColor, wallSideColors } from './finishColors';

describe('home look colours (D41)', () => {
  const rooms = [
    { id: 'a', walls: '#B7C2A6' },
    { id: 'b', walls: 'stripes' },
    { id: 'c', walls: null },
    { id: 'd', walls: 'tartan' }, // unknown wallpaper
  ];

  it('each side: paint, a wallpaper’s colour, unpainted white, or the outside colour', () => {
    const color = wallSideColors(rooms, '#333333');
    expect(color('a')).toBe('#B7C2A6');
    expect(color('b')).toBe('#dfe3e6');
    expect(color('c')).toBe(UNPAINTED);
    expect(color('d')).toBe(UNPAINTED);
    expect(color('gone')).toBe(UNPAINTED);
    expect(color(OUTSIDE)).toBe('#333333');
    expect(wallSideColors(rooms, null)(OUTSIDE)).toBe(EXTERIOR_DEFAULT);
  });

  it('floors: a known finish’s colour, else nothing (plan colour)', () => {
    expect(floorColor({ floor: 'oak' })).toBe('#b98a56');
    expect(floorColor({ floor: 'marble_from_the_future' })).toBeUndefined();
    expect(floorColor({ floor: null })).toBeUndefined();
    expect(floorColor(undefined)).toBeUndefined();
  });

  it('groups wall halves by colour, case-insensitively, in a stable order', () => {
    const box = (side: string) => ({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, side });
    const color = wallSideColors([...rooms, { id: 'e', walls: '#b7c2a6' }], '#333333');
    const groups = groupByColor([box('a'), box(OUTSIDE), box('e'), box('c')], color);
    expect(groups.map((g) => [g.color, g.boxes.length])).toEqual([
      ['#333333', 1],
      ['#b7c2a6', 2],
      [UNPAINTED.toLowerCase(), 1],
    ]);
  });
});
