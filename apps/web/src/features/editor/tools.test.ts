import { describe, expect, it } from 'vitest';
import type { Layout } from '../../domain/layout';
import { itemsAt } from '../../domain/layout';
import { previewRects } from './preview';
import { type ToolContext, toolDown, toolMove, toolUp } from './tools';

const layout: Layout = {
  schemaVersion: 2,
  grid: { tileSize: 1, width: 6, depth: 4 },
  rooms: [{ id: 'rm_a', name: 'A', color: '#112233' }],
  floors: [{ id: 'fl', name: 'F', level: 0, cells: {} }],
  placements: [
    { itemId: 'bottom', floorId: 'fl', x: 1, y: 1, rotation: 0 },
    { itemId: 'top', floorId: 'fl', x: 1, y: 1, rotation: 0 },
    { itemId: 'alone', floorId: 'fl', x: 4, y: 2, rotation: 0 },
  ],
};
const fp = () => [1, 1] as const;

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  tool: 'select',
  floorId: 'fl',
  grid: layout.grid,
  selectedId: null,
  stackAt: (c) => itemsAt(layout, 'fl', c, fp),
  anchorOf: (id) => {
    const p = layout.placements!.find((q) => q.itemId === id);
    return p ? { x: p.x, y: p.y } : null;
  },
  ...over,
});

describe('select tool', () => {
  it('leaves empty tiles and the outside to panning', () => {
    expect(toolDown(ctx(), { x: 0, y: 0 })).toBeNull();
    expect(toolDown(ctx(), { x: -1, y: 0 })).toBeNull();
    expect(toolDown(ctx(), null)).toBeNull();
  });

  it('a click selects the top item; clicking the selected one cycles the stack', () => {
    const g = toolDown(ctx(), { x: 1, y: 1 })!;
    expect(g).toMatchObject({ kind: 'move', itemId: 'top' });
    expect(toolUp(ctx(), g)).toEqual({ type: 'select', itemId: 'top' });

    const g2 = toolDown(ctx({ selectedId: 'top' }), { x: 1, y: 1 })!;
    expect(toolUp(ctx({ selectedId: 'top' }), g2)).toEqual({ type: 'select', itemId: 'bottom' });
    const g3 = toolDown(ctx({ selectedId: 'bottom' }), { x: 1, y: 1 })!;
    expect(g3).toMatchObject({ itemId: 'bottom' }); // dragging takes the selected one
    expect(toolUp(ctx({ selectedId: 'bottom' }), g3)).toEqual({ type: 'select', itemId: 'top' });
  });

  it('dragging moves by the tiles the pointer travelled, clamped to the grid', () => {
    let g = toolDown(ctx(), { x: 4, y: 2 })!;
    g = toolMove(g, { x: 5, y: 3 }, layout.grid);
    g = toolMove(g, { x: 9, y: 9 }, layout.grid);
    expect(toolUp(ctx(), g)).toEqual({ type: 'move', itemId: 'alone', dx: 1, dy: 1 });
  });

  it('an item picked by the view (3D) moves relative to where it was grabbed', () => {
    let g = toolDown(ctx(), { x: 4, y: 0 }, 'alone')!;
    expect(g).toMatchObject({ itemId: 'alone', from: { x: 4, y: 0 } });
    g = toolMove(g, { x: 2, y: 0 }, layout.grid);
    expect(toolUp(ctx(), g)).toEqual({ type: 'move', itemId: 'alone', dx: -2, dy: 0 });
  });
});

describe('paint, erase, place', () => {
  it('paint drags a rectangle; erase too', () => {
    let g = toolDown(ctx({ tool: 'paint' }), { x: 3, y: 1 })!;
    g = toolMove(g, { x: 1, y: 2 }, layout.grid);
    expect(toolUp(ctx(), g)).toEqual({
      type: 'rect',
      floorId: 'fl',
      from: { x: 3, y: 1 },
      to: { x: 1, y: 2 },
      erase: false,
    });
    const e = toolDown(ctx({ tool: 'erase' }), { x: 0, y: 0 })!;
    expect(toolUp(ctx(), e)).toMatchObject({ type: 'rect', erase: true });
    expect(toolDown(ctx({ tool: 'paint' }), { x: 6, y: 0 })).toBeNull();
  });

  it('place follows the pointer and acts where it is released', () => {
    let g = toolDown(ctx({ tool: 'place' }), { x: 0, y: 0 })!;
    g = toolMove(g, { x: 2, y: 3 }, layout.grid);
    expect(toolUp(ctx(), g)).toEqual({ type: 'place', floorId: 'fl', cell: { x: 2, y: 3 } });
  });
});

describe('preview', () => {
  const input = {
    floorId: 'fl',
    layout,
    footprintOf: fp,
    tool: 'paint' as const,
    hover: null,
    place: null,
    paintColor: '#112233',
  };

  it('shows the rectangle being painted or erased', () => {
    expect(
      previewRects({
        ...input,
        gesture: {
          kind: 'rect',
          erase: false,
          floorId: 'fl',
          from: { x: 2, y: 2 },
          to: { x: 0, y: 1 },
        },
      }),
    ).toEqual([{ rect: { x: 0, y: 1, w: 3, h: 2 }, tone: 'paint', color: '#112233' }]);
    expect(
      previewRects({
        ...input,
        gesture: {
          kind: 'rect',
          erase: true,
          floorId: 'other',
          from: { x: 0, y: 0 },
          to: { x: 0, y: 0 },
        },
      }),
    ).toEqual([]);
  });

  it('shows where a dragged item lands, and the cursor tile', () => {
    expect(
      previewRects({
        ...input,
        tool: 'select',
        gesture: {
          kind: 'move',
          itemId: 'alone',
          floorId: 'fl',
          from: { x: 4, y: 2 },
          to: { x: 9, y: 2 },
        },
      }),
    ).toEqual([{ rect: { x: 5, y: 2, w: 1, h: 1 }, tone: 'item' }]);
    expect(
      previewRects({ ...input, gesture: null, hover: { floorId: 'fl', cell: { x: 3, y: 3 } } }),
    ).toEqual([{ rect: { x: 3, y: 3, w: 1, h: 1 }, tone: 'cursor' }]);
    expect(
      previewRects({
        ...input,
        tool: 'place',
        place: { kind: 'type', type: 'fridge' },
        gesture: null,
        hover: { floorId: 'fl', cell: { x: 5, y: 0 } },
      }),
    ).toEqual([{ rect: { x: 5, y: 0, w: 1, h: 1 }, tone: 'item' }]);
  });
});
