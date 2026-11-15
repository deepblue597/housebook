/**
 * What the views draw while a tool is in use: the rectangle being painted or erased, where a
 * dragged item will land, where a new item would go. Shared by the 2D plan and the 3D scene so
 * both show the same thing. Pure.
 */
import { placementSpec } from '../../catalog/catalog';
import type { Rect } from '../../domain/coords';
import {
  type Edge,
  type FootprintOf,
  type Layout,
  edgeRun,
  insideGrid,
  isRoomDivide,
  isWallEdge,
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
  hover: { floorId: string; cell: { x: number; y: number }; edge?: Edge | null } | null;
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
    if (g.kind === 'place') return [{ rect: placeRect(p, g.cell), tone: 'item' }];
    return [];
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

/** A wall edge a door, window or open wall would go on (D36, D51). */
export interface PreviewEdge {
  edge: Edge;
  kind: 'door' | 'window' | 'open';
  /** The tool can act here (else it refuses or skips this edge). */
  ok: boolean;
}

/**
 * The edges the door, window or open-wall tool would act on: the pressed edge (or the run
 * dragged along a wall, for open walls), else the edge under the pointer.
 */
export function previewEdges(p: PreviewInput): PreviewEdge[] {
  if (p.tool !== 'door' && p.tool !== 'window' && p.tool !== 'open') return [];
  const g = p.gesture;
  const floor = p.layout.floors.find((f) => f.id === p.floorId);
  const openHere = (e: Edge) =>
    (p.layout.openings ?? []).some(
      (o) =>
        o.floorId === p.floorId &&
        o.x === e.x &&
        o.y === e.y &&
        o.side === e.side &&
        o.kind === 'open',
    );
  if (p.tool === 'open') {
    const run =
      g?.kind === 'run' && g.floorId === p.floorId
        ? edgeRun(g.from, g.to, p.layout.grid)
        : p.hover?.floorId === p.floorId && p.hover.edge
          ? [p.hover.edge]
          : [];
    if (!run.length) return [];
    // Same rule as the store (toggleOpenRun): starting on an open edge closes, else opens.
    const closing = openHere(run[0]!);
    return run.map((edge) => ({
      edge,
      kind: 'open',
      ok: closing ? openHere(edge) : isRoomDivide(floor?.cells, edge, p.layout.grid),
    }));
  }
  const edge =
    g?.kind === 'edge' && g.floorId === p.floorId
      ? g.edge
      : p.hover?.floorId === p.floorId
        ? (p.hover.edge ?? null)
        : null;
  if (!edge) return [];
  return [{ edge, kind: p.tool, ok: isWallEdge(floor?.cells, edge, p.layout.grid) }];
}
