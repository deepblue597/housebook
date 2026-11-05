/**
 * Pan (drag), zoom (wheel, pinch) for the 3D view, mirroring the 2D plan's usePanZoom: a press
 * that moves less than DRAG_PX stays a click, so items remain clickable. The camera math lives
 * in camera.ts; this only turns pointer events into calls to it.
 */
import { type MouseEvent, type PointerEvent, type RefObject, useEffect, useRef } from 'react';
import { type CameraState, type Viewport, type ZoomLimits, panBy, zoomAt } from './camera';
import { DRAG_PX } from './SceneContent';

export type CameraUpdate = (
  fn: (c: CameraState, vp: Viewport, limits: ZoomLimits) => CameraState,
) => void;

interface Pt {
  x: number;
  y: number;
}

export function useSceneGestures(target: RefObject<HTMLElement | null>, update: CameraUpdate) {
  const pointers = useRef(new Map<number, Pt>());
  const g = useRef({ dragging: false, start: { x: 0, y: 0 }, suppressClick: false });
  const two = useRef<{ x: number; y: number; d: number } | null>(null);
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      updateRef.current((c, vp, limits) =>
        zoomAt(c, factor, vp, e.clientX - r.left, e.clientY - r.top, limits),
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [target]);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = target.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pair = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b
      ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
      : null;
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const p = local(e);
      pointers.current.set(e.pointerId, p);
      if (pointers.current.size === 1) {
        g.current = { dragging: false, start: p, suppressClick: false };
        two.current = null;
      } else {
        g.current.dragging = true;
        two.current = pair();
      }
    },
    onPointerMove: (e: PointerEvent) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pointers.current.set(e.pointerId, p);
      if (pointers.current.size >= 2) {
        const cur = pair();
        const last = two.current;
        two.current = cur;
        if (cur && last) {
          updateRef.current((c, vp, limits) =>
            zoomAt(
              panBy(c, cur.x - last.x, cur.y - last.y),
              last.d > 0 ? cur.d / last.d : 1,
              vp,
              cur.x,
              cur.y,
              limits,
            ),
          );
        }
        return;
      }
      const s = g.current;
      if (!s.dragging && Math.hypot(p.x - s.start.x, p.y - s.start.y) < DRAG_PX) return;
      if (!s.dragging) {
        s.dragging = true;
        target.current?.setPointerCapture?.(e.pointerId);
      }
      updateRef.current((c) => panBy(c, p.x - prev.x, p.y - prev.y));
    },
    onPointerUp: (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (g.current.dragging) g.current.suppressClick = true;
      if (pointers.current.size === 0) g.current.dragging = false;
      two.current = null;
    },
    onPointerCancel: (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 0) g.current.dragging = false;
      two.current = null;
    },
    // A drag ends with a click on whatever is under the pointer; swallow it before the scene
    // (react-three-fiber listens below this element) sees it.
    onClickCapture: (e: MouseEvent) => {
      if (g.current.suppressClick) {
        g.current.suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
}
