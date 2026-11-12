import { describe, expect, it } from 'vitest';
import {
  EXTERIOR_DEFAULT,
  floorFinishes,
  shippedTextures,
  wallpaperFinishes,
} from '../../catalog/finishes';
import { OUTSIDE } from '../../domain/scene';
import { UNPAINTED, floorSurface, groupBySurface, wallSideSurfaces } from './finishColors';

describe('home look surfaces (D41, D42)', () => {
  const rooms = [
    { id: 'a', walls: '#B7C2A6' },
    { id: 'b', walls: 'stripes' },
    { id: 'c', walls: null },
    { id: 'd', walls: 'tartan' }, // unknown wallpaper
  ];

  it('each wall side: paint, a textured wallpaper, unpainted white, or the outside colour', () => {
    const surface = wallSideSurfaces(rooms, '#333333');
    expect(surface('a')).toEqual({ key: '#b7c2a6', color: '#B7C2A6' });
    const stripes = surface('b');
    expect(stripes).toMatchObject({ key: 'wallpaper:stripes', color: '#dce2e6' });
    expect(stripes.texture?.size).toEqual([0.5, 0.5]);
    expect(stripes.texture?.url).toMatch(/wallpaper-stripes/);
    expect(surface('c').color).toBe(UNPAINTED);
    expect(surface('d').color).toBe(UNPAINTED);
    expect(surface(OUTSIDE).color).toBe('#333333');
    expect(wallSideSurfaces(rooms, null)(OUTSIDE).color).toBe(EXTERIOR_DEFAULT);
  });

  it('floors: a known finish with its texture and real size, else nothing (plan colour)', () => {
    const oak = floorSurface({ floor: 'oak' })!;
    expect(oak).toMatchObject({ key: 'floor:oak', color: '#9b7b5d' });
    expect(oak.texture?.size).toEqual([1.8, 1.8]);
    expect(floorSurface({ floor: 'checker' })!.texture?.url).toMatch(/checker/);
    expect(floorSurface({ floor: 'marble_from_the_future' })).toBeUndefined();
    expect(floorSurface(undefined)).toBeUndefined();
  });

  it('your own textures (D43): found by key and kind, drawn from their server URL', () => {
    const own = [
      {
        key: 'my_floor1',
        label: 'Marble',
        kind: 'floor' as const,
        size: [0.6, 0.3] as [number, number],
        color: '#dddddd',
        url: '/api/textures/my_floor1?v=1',
      },
      {
        key: 'my_paper1',
        label: 'Roses',
        kind: 'wallpaper' as const,
        size: [0.5, 0.5] as [number, number],
        color: '#eeaaaa',
        url: null, // the image is missing: colour only
      },
    ];
    const floor = floorSurface({ floor: 'my_floor1' }, own)!;
    expect(floor).toMatchObject({ key: 'floor:my_floor1', color: '#dddddd' });
    expect(floor.texture).toEqual({ url: '/api/textures/my_floor1?v=1', size: [0.6, 0.3] });
    expect(floorSurface({ floor: 'my_floor1' })).toBeUndefined(); // not known without the list
    expect(floorSurface({ floor: 'my_paper1' }, own)).toBeUndefined(); // a wallpaper isn't a floor
    const surface = wallSideSurfaces([{ id: 'a', walls: 'my_paper1' }], null, own);
    expect(surface('a')).toEqual({
      key: 'wallpaper:my_paper1',
      color: '#eeaaaa',
      texture: undefined,
    });
  });

  it('every finish in the catalogue has a shipped texture', () => {
    const shipped = new Set(shippedTextures());
    for (const f of [...floorFinishes(), ...wallpaperFinishes()])
      expect(shipped).toContain(f.texture);
  });

  it('groups wall halves by surface: same paint (any case) together, wallpapers apart', () => {
    const box = (side: string) => ({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, side });
    const surface = wallSideSurfaces([...rooms, { id: 'e', walls: '#b7c2a6' }], '#333333');
    const groups = groupBySurface([box('a'), box(OUTSIDE), box('e'), box('b'), box('c')], surface);
    expect(groups.map((g) => [g.surface.key, g.boxes.length])).toEqual([
      ['#333333', 1],
      ['#b7c2a6', 2],
      [UNPAINTED.toLowerCase(), 1],
      ['wallpaper:stripes', 1],
    ]);
  });
});
