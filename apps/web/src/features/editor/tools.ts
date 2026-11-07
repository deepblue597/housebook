/**
 * Editor tools as small state machines (DESIGN §7.3): each gets pointer down/move/up with the
 * grid cell under the pointer and returns the gesture to preview, then the effect to apply.
 * Both views (2D plan, 3D scene) translate pointer positions to cells and forward them here
 * through `useToolPointer`. Pure: no React, no stores.
 */
import type { Cell } from '../../domain/coords';
import { clampToGrid, cycleStack, insideGrid } from '../../domain/layout';
import type { Gesture, Tool } from '../../store/editor';

export interface ToolContext {
  tool: Tool;
  floorId: string;
  grid: { width: number; depth: number };
  selectedId: string | null;
  /** Items (and ghosts) covering a cell on this floor, bottom first (stacking order). */
  stackAt: (cell: Cell) => string[];
  /** The anchor cell of an item on this floor, if it is placed there. */
  anchorOf: (itemId: string) => Cell | null;
}

export type ToolEffect =
  | { type: 'rect'; floorId: string; from: Cell; to: Cell; erase: boolean }
  | { type: 'move'; itemId: string; dx: number; dy: number }
  | { type: 'select'; itemId: string }
  | { type: 'place'; floorId: string; cell: Cell };

/** Top of the stack first: what a click sees. */
const topFirst = (stack: readonly string[]) => [...stack].reverse();

/**
 * Pointer down. Returns the gesture to start, or `null` when the tool doesn't want this press
 * (the view pans instead): the select tool on an empty tile, any tool outside the grid.
 * `picked` is the item the view hit directly (3D raycast), if any.
 */
export function toolDown(
  ctx: ToolContext,
  cell: Cell | null,
  picked: string | null = null,
): Gesture | null {
  if (ctx.tool === 'select') {
    if (picked) {
      // The item moves by as many tiles as the pointer does, from wherever it was grabbed.
      const at = cell ? clampToGrid(cell, ctx.grid) : ctx.anchorOf(picked);
      return at ? { kind: 'move', itemId: picked, floorId: ctx.floorId, from: at, to: at } : null;
    }
    if (!cell || !insideGrid(cell, ctx.grid)) return null;
    const stack = topFirst(ctx.stackAt(cell));
    if (!stack.length) return null;
    // Dragging takes the selected item if it is in this stack, else the top one.
    const itemId = ctx.selectedId && stack.includes(ctx.selectedId) ? ctx.selectedId : stack[0]!;
    return { kind: 'move', itemId, floorId: ctx.floorId, from: cell, to: cell };
  }
  if (!cell || !insideGrid(cell, ctx.grid)) return null;
  if (ctx.tool === 'place') return { kind: 'place', floorId: ctx.floorId, cell };
  return { kind: 'rect', erase: ctx.tool === 'erase', floorId: ctx.floorId, from: cell, to: cell };
}

/** Pointer move during a gesture: follow the pointer, staying on the grid. */
export function toolMove(g: Gesture, cell: Cell | null, grid: ToolContext['grid']): Gesture {
  if (!cell) return g;
  const c = clampToGrid(cell, grid);
  if (g.kind === 'place') return c.x === g.cell.x && c.y === g.cell.y ? g : { ...g, cell: c };
  return c.x === g.to.x && c.y === g.to.y ? g : { ...g, to: c };
}

/** Pointer up: the effect of the finished gesture. */
export function toolUp(ctx: ToolContext, g: Gesture): ToolEffect | null {
  switch (g.kind) {
    case 'rect':
      return { type: 'rect', floorId: g.floorId, from: g.from, to: g.to, erase: g.erase };
    case 'place':
      return { type: 'place', floorId: g.floorId, cell: g.cell };
    case 'move': {
      const dx = g.to.x - g.from.x;
      const dy = g.to.y - g.from.y;
      if (dx !== 0 || dy !== 0) return { type: 'move', itemId: g.itemId, dx, dy };
      // A click: select, and a click on the selected item cycles through its stack (15.16).
      const here = ctx.stackAt(g.from);
      const at = ctx.anchorOf(g.itemId);
      const stack = topFirst(here.includes(g.itemId) || !at ? here : ctx.stackAt(at));
      const itemId =
        ctx.selectedId === g.itemId ? (cycleStack(stack, g.itemId) ?? g.itemId) : g.itemId;
      return { type: 'select', itemId };
    }
  }
}
