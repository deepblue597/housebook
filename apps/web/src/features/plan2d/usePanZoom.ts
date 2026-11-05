/**
 * Pan and zoom for the plan: mouse drag and wheel, one-finger pan and two-finger pinch.
 * A press that moves less than DRAG_PX stays a click, so items remain clickable.
 */
import {
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface View {
  k: number; // scale: screen px per plan unit
  tx: number;
  ty: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_K = 0.2;
const MAX_K = 6;
const DRAG_PX = 6;
const PAD = 12;

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export function fitView(bounds: Bounds, width: number, height: number): View {
  const k = clampK(Math.min((width - 2 * PAD) / bounds.w, (height - 2 * PAD) / bounds.h) || 1);
  return {
    k,
    tx: (width - bounds.w * k) / 2 - bounds.x * k,
    ty: (height - bounds.h * k) / 2 - bounds.y * k,
  };
}

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, tx: px - (px - v.tx) * f, ty: py - (py - v.ty) * f };
}

/** Midpoint and finger distance of a two-finger gesture, in viewport px. */
export interface TwoFinger {
  x: number;
  y: number;
  d: number;
}

/**
 * One step of a two-finger gesture: zoom by the change in finger distance and move the plan
 * point that was under the previous midpoint to the new midpoint. Pan and pinch in one go, so
 * the anchor doesn't drift and two fingers moving together pan the plan.
 */
export function twoFingerStep(v: View, prev: TwoFinger, cur: TwoFinger): View {
  const k = prev.d > 0 ? clampK((v.k * cur.d) / prev.d) : v.k;
  const f = k / v.k;
  return { k, tx: cur.x - (prev.x - v.tx) * f, ty: cur.y - (prev.y - v.ty) * f };
}

export function usePanZoom(target: RefObject<HTMLElement | null>, bounds: Bounds, fitKey: string) {
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const userMoved = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    /** Two-finger state as last applied. */
    two: TwoFinger | null;
    /** Pending animation frame that applies the two-finger step. */
    frame: number | null;
  }>({
    dragging: false,
    startX: 0,
    startY: 0,
    two: null,
    frame: null,
  });
  const suppressClick = useRef(false);

  const fit = () => {
    const el = target.current;
    if (!el) return;
    userMoved.current = false;
    setView(fitView(bounds, el.clientWidth, el.clientHeight));
  };

  const zoomBy = (factor: number) => {
    const el = target.current;
    if (!el) return;
    userMoved.current = true;
    setView((v) => zoomAt(v, factor, el.clientWidth / 2, el.clientHeight / 2));
  };

  // Fit on mount, on floor change and on resize (unless the user has moved the plan since).
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    userMoved.current = false;
    const refit = () => {
      if (!userMoved.current) setView(fitView(bounds, el.clientWidth, el.clientHeight));
    };
    const raf = requestAnimationFrame(refit);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit);
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [target, bounds, fitKey]);

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      userMoved.current = true;
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [target]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = target.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const twoFinger = (): TwoFinger | null => {
    const [a, b] = [...pointers.current.values()];
    return a && b
      ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
      : null;
  };

  // Each finger moves in its own pointer event. Apply the gesture once per frame, after both
  // fingers have reported, so the midpoint and distance come from the same moment.
  const applyTwoFinger = () => {
    const g = gesture.current;
    g.frame = null;
    const cur = twoFinger();
    const prev = g.two;
    if (!cur || !prev) return;
    g.two = cur;
    userMoved.current = true;
    setView((v) => twoFingerStep(v, prev, cur));
  };

  const endTwoFinger = () => {
    const g = gesture.current;
    if (g.frame !== null) {
      cancelAnimationFrame(g.frame);
      applyTwoFinger();
    }
    g.two = null;
  };

  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const p = local(e);
      pointers.current.set(e.pointerId, p);
      const g = gesture.current;
      if (pointers.current.size === 1) {
        suppressClick.current = false;
        g.dragging = false;
        g.startX = p.x;
        g.startY = p.y;
        g.two = null;
      } else {
        g.dragging = true;
        g.two = twoFinger();
      }
    },
    onPointerMove: (e: PointerEvent) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pointers.current.set(e.pointerId, p);
      const g = gesture.current;
      if (pointers.current.size >= 2) {
        g.frame ??= requestAnimationFrame(applyTwoFinger);
        return;
      }
      if (!g.dragging && Math.hypot(p.x - g.startX, p.y - g.startY) < DRAG_PX) return;
      if (!g.dragging) {
        g.dragging = true;
        // Capture only once it is a drag, so a plain click still reaches the item under it.
        target.current?.setPointerCapture?.(e.pointerId);
      }
      userMoved.current = true;
      setView((v) => ({ ...v, tx: v.tx + p.x - prev.x, ty: v.ty + p.y - prev.y }));
    },
    onPointerUp: (e: PointerEvent) => {
      if (pointers.current.size >= 2) endTwoFinger();
      pointers.current.delete(e.pointerId);
      if (gesture.current.dragging) suppressClick.current = true;
      if (pointers.current.size === 0) gesture.current.dragging = false;
    },
    onPointerCancel: (e: PointerEvent) => {
      if (pointers.current.size >= 2) endTwoFinger();
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 0) gesture.current.dragging = false;
    },
    // A drag ends with a click on whatever is under the pointer; swallow it.
    onClickCapture: (e: MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };

  return { view, fit, zoomBy, handlers };
}
