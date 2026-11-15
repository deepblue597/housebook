/**
 * Forwards pointer events from a view (2D plan or 3D scene) to the active editor tool, as grid
 * cells (DESIGN §7.3). Presses the tool doesn't want (select tool on an empty tile, anything
 * outside the grid), second fingers and wheel zoom go to the view's own pan/zoom handlers, so
 * panning and pinching keep working in edit mode. In view mode the pan handlers are returned
 * unchanged.
 *
 * Also the drop target for items dragged from the Unplaced tray.
 */
import type { DragEvent, MouseEvent, PointerEvent, RefObject } from 'react';
import { useRef } from 'react';
import type { PointerCell } from '../../domain/coords';
import { insideGrid, itemsAt, nearestEdge } from '../../domain/layout';
import { useData } from '../../store/data';
import { applyContext, useEditor } from '../../store/editor';
import { useUi } from '../../store/ui';
import { type ToolContext, type ToolEffect, toolDown, toolMove, toolUp } from './tools';

/** Pointer travel (CSS px) before a press on an item becomes a drag (as for panning). */
const DRAG_PX = 6;

/** `dataTransfer` type of an item dragged from the Unplaced tray. */
export const TRAY_MIME = 'application/x-housebook-item';

export interface PointerHandlers {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onClickCapture: (e: MouseEvent) => void;
}

export interface EditPointerHandlers extends PointerHandlers {
  onPointerLeave?: (e: PointerEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}

interface Options {
  floorId: string;
  /** The element the handlers go on (pointer capture). */
  target: RefObject<HTMLElement | null>;
  /** Client (CSS px) position → the grid cell under it (and where in it); may be outside. */
  toCell: (clientX: number, clientY: number) => PointerCell | null;
  /** The view's own pan/zoom handlers. */
  pan: PointerHandlers;
  /** The item the view's own picking has under the pointer (3D), if any. */
  pick?: () => string | null;
}

function toolContext(floorId: string): ToolContext | null {
  const model = useData.getState().model;
  const house = model?.snapshot.house;
  if (!model || !house) return null;
  const sel = useUi.getState().selection;
  const { footprintOf } = applyContext();
  return {
    tool: useEditor.getState().tool,
    floorId,
    grid: model.grid,
    selectedId: sel?.kind === 'item' ? sel.id : null,
    stackAt: (c) => itemsAt(house, floorId, c, footprintOf),
    anchorOf: (id) => {
      const p = (house.placements ?? []).find((q) => q.itemId === id && q.floorId === floorId);
      return p ? { x: p.x, y: p.y } : null;
    },
  };
}

function apply(fx: ToolEffect) {
  const ed = useEditor.getState();
  const select = (id: string) => useUi.getState().select({ kind: 'item', id });
  switch (fx.type) {
    case 'rect':
      ed.paintRect(fx.floorId, fx.from, fx.to, fx.erase);
      break;
    case 'move':
      ed.moveItem(fx.itemId, fx.dx, fx.dy);
      select(fx.itemId);
      break;
    case 'select':
      select(fx.itemId);
      break;
    case 'place':
      ed.placeAt(fx.floorId, fx.cell);
      break;
    case 'opening':
      ed.toggleOpening(fx.floorId, fx.edge, fx.kind);
      break;
    case 'openRun':
      ed.toggleOpenRun(fx.floorId, fx.edges);
      break;
  }
}

export function useToolPointer({
  floorId,
  target,
  toCell,
  pan,
  pick,
}: Options): EditPointerHandlers {
  const mode = useEditor((s) => s.mode);
  /** The pointer the tool owns, where it went down, and whether it has started dragging. */
  const own = useRef<{
    id: number;
    x: number;
    y: number;
    dragging: boolean;
    down: PointerEvent;
  } | null>(null);
  const panning = useRef(new Set<number>());
  const suppressClick = useRef(false);

  if (mode !== 'edit') return pan;

  const cellAt = (e: { clientX: number; clientY: number }) => toCell(e.clientX, e.clientY);
  const grid = () => useData.getState().model?.grid ?? { width: 0, depth: 0 };
  const hoverAt = (cell: PointerCell | null) => {
    const ed = useEditor.getState();
    if (!cell || !insideGrid(cell, grid())) return ed.setHover(null);
    const edge =
      ed.tool === 'door' || ed.tool === 'window' || ed.tool === 'open'
        ? nearestEdge(cell)
        : undefined;
    ed.setHover({ floorId, cell: { x: cell.x, y: cell.y }, ...(edge !== undefined && { edge }) });
  };
  const toPan = (e: PointerEvent) => {
    panning.current.add(e.pointerId);
    pan.onPointerDown(e);
  };

  return {
    onPointerDown: (e) => {
      // A mouse has one pointer: anything still tracked was released outside the view.
      if (e.pointerType === 'mouse') {
        panning.current.clear();
        if (own.current) {
          own.current = null;
          useEditor.getState().setGesture(null);
        }
      }
      // A second finger: give up the tool gesture and let the view pinch/pan with both.
      if (own.current || panning.current.size > 0) {
        const first = own.current;
        if (first) {
          own.current = null;
          useEditor.getState().setGesture(null);
          toPan(first.down);
        }
        suppressClick.current = false;
        toPan(e);
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const ctx = toolContext(floorId);
      const g = ctx ? toolDown(ctx, cellAt(e), pick?.() ?? null) : null;
      suppressClick.current = !!g;
      if (!g) {
        toPan(e);
        return;
      }
      own.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, down: e };
      useEditor.getState().setGesture(g);
      target.current?.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e) => {
      const o = own.current;
      if (o && o.id === e.pointerId) {
        if (!o.dragging && Math.hypot(e.clientX - o.x, e.clientY - o.y) < DRAG_PX) return;
        o.dragging = true;
        const ed = useEditor.getState();
        if (ed.gesture) ed.setGesture(toolMove(ed.gesture, cellAt(e), grid()));
        return;
      }
      if (panning.current.has(e.pointerId)) {
        pan.onPointerMove(e);
        return;
      }
      // Hovering (no button down): show where the tool would act.
      const tool = useEditor.getState().tool;
      if (e.buttons === 0 && tool !== 'select') hoverAt(cellAt(e));
    },
    onPointerUp: (e) => {
      const o = own.current;
      if (o && o.id === e.pointerId) {
        own.current = null;
        const ed = useEditor.getState();
        const g = ed.gesture;
        ed.setGesture(null);
        if (target.current?.hasPointerCapture?.(e.pointerId))
          target.current.releasePointerCapture(e.pointerId);
        const ctx = toolContext(floorId);
        const fx = g && ctx ? toolUp(ctx, g) : null;
        if (fx) apply(fx);
        return;
      }
      panning.current.delete(e.pointerId);
      pan.onPointerUp(e);
    },
    onPointerCancel: (e) => {
      if (own.current?.id === e.pointerId) {
        own.current = null;
        useEditor.getState().setGesture(null);
        return;
      }
      panning.current.delete(e.pointerId);
      pan.onPointerCancel(e);
    },
    onPointerLeave: () => {
      if (!own.current) useEditor.getState().setHover(null);
    },
    // The tool handled the press: the click that follows must not also select a room/item.
    onClickCapture: (e) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      pan.onClickCapture(e);
    },
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(TRAY_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      hoverAt(cellAt(e));
    },
    onDragLeave: () => useEditor.getState().setHover(null),
    onDrop: (e) => {
      const id = e.dataTransfer.getData(TRAY_MIME);
      useEditor.getState().setHover(null);
      if (!id) return;
      e.preventDefault();
      const cell = cellAt(e);
      if (!cell || !insideGrid(cell, grid())) return;
      if (useEditor.getState().placeItemAt(id, floorId, cell))
        useUi.getState().select({ kind: 'item', id });
    },
  };
}
