/**
 * What the views draw while a tool is in use: the rectangle being painted or erased, where a
 * dragged item will land, where a new item would go. Shared by the 2D plan and the 3D scene so
 * both show the same thing. Pure.
 */
import { placementSpec } from '../../catalog/catalog';
import type { Rect } from '../../domain/coords';
import {
  type FootprintOf,
  type Layout,
  insideGrid,
  movedPlacement,
  placementRect,
  rectBetween,
} from '../../domain/layout';
import type { Gesture, PlaceSource, Tool } from '../../store/editor';

export interface PreviewRect {
  rect: Rect;
  /** paint: tiles painted with `color`; erase: tiles cleared; item: an item's footprint;
   *  cursor: the tile under the pointer. */
  tone: 'paint' | 'erase' | 'item' | 'cursor';
  color?: string;
}

export interface PreviewInput {
  floorId: string;
  layout: Layout;
  footprintOf: FootprintOf;
  tool: Tool;
  gesture: Gesture | null;
  hover: { floorId: string; cell: { x: number; y: number } } | null;
  place: PlaceSource | null;
  paintColor: string | null;
}

export function previewRects(p: PreviewInput): PreviewRect[] {
  const { gesture: g, layout } = p;
  if (g && g.floorId === p.floorId) {
    if (g.kind === 'rect') {
      const rect = rectBetween(g.from, g.to);
      return [
        g.erase
          ? { rect, tone: 'erase' }
          : { rect, tone: 'paint', ...(p.paintColor ? { color: p.paintColor } : {}) },
      ];
    }
    if (g.kind === 'move') {
      const pl = (layout.placements ?? []).find((q) => q.itemId === g.itemId);
      const to =
        pl && movedPlacement(pl, g.to.x - g.from.x, g.to.y - g.from.y, layout.grid, p.footprintOf);
      return to ? [{ rect: placementRect(to, p.footprintOf), tone: 'item' }] : [];
    }
    return [{ rect: placeRect(p, g.cell), tone: 'item' }];
  }
  const h = p.hover;
  if (!h || h.floorId !== p.floorId || !insideGrid(h.cell, layout.grid)) return [];
  if (p.tool === 'place' && p.place) return [{ rect: placeRect(p, h.cell), tone: 'item' }];
  if (p.tool === 'paint' || p.tool === 'erase')
    return [{ rect: { ...h.cell, w: 1, h: 1 }, tone: 'cursor' }];
  return [];
}

/** The footprint a new placement at `cell` would cover (rotation 0), kept inside the grid. */
function placeRect(p: PreviewInput, cell: { x: number; y: number }): Rect {
  const fp =
    p.place?.kind === 'item'
      ? p.footprintOf(p.place.itemId)
      : placementSpec(p.place?.kind === 'type' ? p.place.type : null).footprint;
  const w = Math.min(fp[0], p.layout.grid.width);
  const h = Math.min(fp[1], p.layout.grid.depth);
  return {
    x: Math.min(cell.x, p.layout.grid.width - w),
    y: Math.min(cell.y, p.layout.grid.depth - h),
    w,
    h,
  };
}
