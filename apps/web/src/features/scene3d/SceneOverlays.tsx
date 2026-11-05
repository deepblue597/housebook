/**
 * HTML overlays on the 3D view: room labels, status badges and the hovered or selected item's
 * name. Plain DOM in the app's own React tree, placed with the same projection as the camera
 * (camera.ts `project`, checked against three.js in camera.test.ts) and moved imperatively on
 * every drawn frame, so a camera move doesn't re-render React. Decorative for assistive tech:
 * the 2D plan and the list carry the same information as text.
 *
 * (drei's <Html> mounts a React root per label, which React 19 can't unmount cleanly while the
 * scene itself is unmounting; this avoids that and one DOM root per item.)
 */
import { type Ref, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Vec3 } from '../../domain/scene';
import { type CameraState, type Viewport, project } from './camera';

export interface Anchor {
  key: string;
  /** World point the element is centred on. */
  world: Vec3;
  className: string;
  text: string;
}

export interface OverlayHandle {
  place: (c: CameraState, vp: Viewport) => void;
}

export function SceneOverlays({
  anchors,
  handle,
  view,
}: {
  anchors: readonly Anchor[];
  handle: Ref<OverlayHandle>;
  /** The camera and viewport of the last drawn frame, if any. */
  view: () => { cam: CameraState; vp: Viewport } | null;
}) {
  const els = useRef(new Map<string, HTMLElement>());
  const place = useCallback(
    (c: CameraState, vp: Viewport) => {
      for (const a of anchors) {
        const el = els.current.get(a.key);
        if (!el) continue;
        const s = project(c, vp, a.world);
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
      }
    },
    [anchors],
  );
  useImperativeHandle(handle, () => ({ place }), [place]);
  // New or changed anchors are placed right away, without waiting for the next frame.
  useLayoutEffect(() => {
    const v = view();
    if (v) place(v.cam, v.vp);
  }, [place, view]);

  return (
    <div className="overlay3d" aria-hidden="true">
      {anchors.map((a) => (
        <span
          key={a.key}
          data-anchor={a.key}
          className={a.className}
          ref={(el) => {
            if (!el) return;
            els.current.set(a.key, el);
            return () => {
              els.current.delete(a.key);
            };
          }}
        >
          {a.text}
        </span>
      ))}
    </div>
  );
}
