/**
 * The 3D view (milestone 2): a lazy chunk with three.js, react-three-fiber and drei, loaded the
 * first time someone opens 3D (DESIGN 15.10). A pure rendering of the same stores as the 2D
 * plan; its only own state is the camera (and the "walls up" toggle and hover).
 *
 * The canvas is not the accessible path (DESIGN 15.12): it says so and points to the 2D plan
 * and the list, which show the same rooms and items as focusable, labelled controls.
 */
import { Canvas } from '@react-three/fiber';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useResolvedTheme } from '../../app/theme';
import type { SceneTestHook } from '../../app/testHook';
import { FloorTabs } from '../../components/FloorTabs';
import { currentStatus } from '../../components/status';
import { CEILING_HEIGHT, CUT_HEIGHT } from '../../domain/scene';
import type { Level } from '../../domain/status';
import { useData } from '../../store/data';
import type { FloorModel } from '../../store/model';
import { useSearchResults } from '../../store/search';
import { useUi } from '../../store/ui';
import { modelStatus, subscribe as onModelChange } from './models/library';
import {
  type CameraState,
  type Viewport,
  type ZoomLimits,
  fitBox,
  focusOn,
  heading,
  panBy,
  project,
  rotateBy,
  sameCamera,
  zoomAt,
  zoomLimits,
} from './camera';
import { CameraRig } from './CameraRig';
import { itemTop, sceneLayout } from './layout';
import { scenePalette } from './palette';
import { SceneContent } from './SceneContent';
import { type Anchor, type OverlayHandle, SceneOverlays } from './SceneOverlays';
import { useSceneGestures } from './useSceneGestures';

const REDUCED = '(prefers-reduced-motion: reduce)';
const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia?.(REDUCED);
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
};
const prefersReducedMotion = () => window.matchMedia?.(REDUCED).matches ?? false;

const PAN_STEP = 60; // px per arrow key press
/** The zoom readout for screen readers waits until wheel/pinch zooming pauses. */
const ZOOM_SAY_MS = 500;

const BADGE: Record<Level, { tone: string; glyph: string }> = {
  overdue: { tone: 'bad', glyph: '!' },
  due_soon: { tone: 'warn', glyph: '◆' },
  warranty_ending: { tone: 'warn', glyph: '■' },
};

interface CamSlot {
  goal: CameraState;
  instant: boolean;
}

/** What the last drawn frame showed (for the test hook, the overlays and `moving()`). */
interface Shown {
  cam: CameraState | null;
  /** The goal the rig was heading for, and the canvas size, in that frame. */
  goal: CameraState | null;
  size: Viewport | null;
  moving: boolean;
  frames: number;
}

const sameSize = (a: Viewport | null, b: Viewport | null) =>
  !!a && !!b && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;

export default function Scene3dView({ floor }: { floor: FloorModel }) {
  const model = useData((s) => s.model)!;
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const setScene3dIssue = useUi((s) => s.setScene3dIssue);
  const search = useSearchResults();
  const theme = useResolvedTheme();
  const reducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false);
  const palette = useMemo(() => scenePalette(theme), [theme]);

  const [wallsUp, setWallsUp] = useState(false);
  const wallHeight = wallsUp ? CEILING_HEIGHT : CUT_HEIGHT;
  const layout = useMemo(() => sceneLayout(model, floor, wallHeight), [model, floor, wallHeight]);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const stage = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<CamSlot | null>(null);
  /**
   * The camera goal, updated the moment a change is asked for (before React renders it), so
   * consecutive changes build on each other and the test hook knows a move is pending.
   */
  const goalRef = useRef<CameraState | null>(null);
  const setGoal = useCallback((goal: CameraState, instant: boolean) => {
    const first = !goalRef.current;
    goalRef.current = goal;
    setCam({ goal, instant: instant || first });
  }, []);
  const userMoved = useRef(false);
  const shown = useRef<Shown>({ cam: null, goal: null, size: null, moving: false, frames: 0 });
  /** Camera changes scheduled for the next animation frame (fit, focus), not yet asked for. */
  const scheduled = useRef(0);
  const nextFrame = useCallback((fn: () => void) => {
    scheduled.current += 1;
    let done = false;
    const finish = () => {
      if (!done) scheduled.current -= 1;
      done = true;
    };
    const raf = requestAnimationFrame(() => {
      finish();
      fn();
    });
    return () => {
      cancelAnimationFrame(raf);
      finish();
    };
  }, []);

  const vpNow = useCallback((): Viewport | null => {
    const el = viewport.current;
    return el && el.clientWidth > 0 ? { width: el.clientWidth, height: el.clientHeight } : null;
  }, []);

  const tileSize = layout.tileSize;
  const sphere = layout.sphere;
  const limits = useMemo((): ZoomLimits => zoomLimits(sphere, tileSize), [sphere, tileSize]);

  /** Change the camera; `instant` skips the easing (drag, wheel) and so does reduced motion. */
  const move = useCallback(
    (fn: (c: CameraState, vp: Viewport, limits: ZoomLimits) => CameraState, instant: boolean) => {
      const vp = vpNow();
      const from = goalRef.current;
      if (!vp || !from) return;
      userMoved.current = true;
      setGoal(fn(from, vp, limits), instant || reducedMotion);
    },
    [vpNow, limits, reducedMotion, setGoal],
  );
  const gestures = useSceneGestures(
    viewport,
    useCallback((fn) => move(fn, true), [move]),
  );

  const fit = useCallback(
    (instant: boolean) => {
      const vp = vpNow();
      if (!vp) return;
      userMoved.current = false;
      setGoal(
        fitBox(layout.bounds, goalRef.current?.angle ?? 0, vp, limits),
        instant || reducedMotion,
      );
    },
    [vpNow, layout.bounds, limits, reducedMotion, setGoal],
  );

  /** Turn in 90° steps; a camera the user hasn't moved stays fitted to the floor. */
  const rotate = useCallback(
    (steps: number) => {
      const vp = vpNow();
      const from = goalRef.current;
      if (!vp || !from) return;
      const r = rotateBy(from, steps);
      setGoal(userMoved.current ? r : fitBox(layout.bounds, r.angle, vp, limits), reducedMotion);
    },
    [vpNow, layout.bounds, limits, reducedMotion, setGoal],
  );

  // Fit on mount, on floor change and on resize, unless the user has moved the camera since.
  const floorId = floor.floor.id;
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    userMoved.current = false;
    const refit = () => {
      if (!userMoved.current) fitRef.current(true);
    };
    const cancel = nextFrame(refit);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit);
    ro?.observe(el);
    return () => {
      cancel();
      ro?.disconnect();
    };
  }, [floorId, nextFrame]);
  // Walls up/down changes the box to fit; refit only if the user hasn't moved.
  useEffect(
    () =>
      nextFrame(() => {
        if (!userMoved.current) fitRef.current(false);
      }),
    [wallHeight, nextFrame],
  );

  // Centre the selected item (search result, deep link, list, 2D plan), once per selection and
  // floor. A click on the item in this view doesn't move the camera under the pointer.
  const selectedId = selection?.kind === 'item' ? selection.id : null;
  const pickedHere = useRef<string | null>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const key = selectedId && `${selectedId}@${layout.floorId}`;
    if (!key || focused.current === key) return;
    const it = layout.items.find((i) => i.id === selectedId);
    if (!it) return;
    return nextFrame(() => {
      focused.current = key;
      if (pickedHere.current === selectedId) {
        pickedHere.current = null;
        return;
      }
      const vp = vpNow();
      if (!vp) return;
      userMoved.current = true;
      const from = goalRef.current ?? fitBox(layout.bounds, 0, vp, limits);
      setGoal(focusOn(from, it.transform.position, limits), reducedMotion);
    });
  }, [selectedId, layout, vpNow, limits, reducedMotion, setGoal, nextFrame]);
  useEffect(() => {
    if (selectedId) return;
    focused.current = null;
    pickedHere.current = null;
  }, [selectedId]);

  const onItem = useCallback(
    (id: string) => {
      // Only a click that changes the selection reaches the centring effect above; marking a
      // click on the already-selected item would cancel the next centring from elsewhere (M2-01).
      const cur = useUi.getState().selection;
      if (!(cur?.kind === 'item' && cur.id === id)) pickedHere.current = id;
      select({ kind: 'item', id });
    },
    [select],
  );
  const onRoom = useCallback(
    (roomId: string) => select({ kind: 'room', roomId, floorId }),
    [select, floorId],
  );
  const onHover = useCallback((id: string | null) => {
    setHoverId(id);
    if (viewport.current) viewport.current.style.cursor = id ? 'pointer' : '';
  }, []);

  // WebGL context loss (iOS under memory pressure, GPU resets): fall back to 2D with a
  // "reload 3D" button (DESIGN 15.10). The listener goes before the canvas is disposed, so
  // our own unmount (which forces a context loss) isn't reported.
  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const renderer = useRef<{ forceContextLoss: () => void } | null>(null);
  const onLost = useCallback(
    (e: Event) => {
      e.preventDefault();
      // The context is already gone: react-three-fiber's unmount would force-lose it again and
      // three.js would log "WEBGL_lose_context extension not supported".
      if (renderer.current) renderer.current.forceContextLoss = () => {};
      // Keyboard focus inside the 3D view would drop to <body> when it unmounts (M2-02).
      const active = document.activeElement;
      setScene3dIssue('context_lost', !!active && !!stage.current?.contains(active));
    },
    [setScene3dIssue],
  );
  useEffect(
    () => () => {
      canvasEl.current?.removeEventListener('webglcontextlost', onLost);
    },
    [onLost],
  );

  const overlays = useRef<OverlayHandle>(null);
  const onFrame = useCallback(
    (c: CameraState, goal: CameraState, size: Viewport, moving: boolean) => {
      const s = shown.current;
      s.cam = c;
      s.goal = goal;
      s.size = size;
      s.moving = moving;
      s.frames += 1;
      // Marks the first drawn frame (tests wait for it; no hook needed).
      if (s.frames === 1) viewport.current?.setAttribute('data-ready', 'true');
      const vp = vpNow();
      if (vp) overlays.current?.place(c, vp);
    },
    [vpNow],
  );
  const lastView = useCallback(() => {
    const c = shown.current.cam;
    const vp = vpNow();
    return c && vp ? { cam: c, vp } : null;
  }, [vpNow]);

  // Room labels, status badges (same status rules as 2D) and the hovered/selected item's name.
  const snapshot = model.snapshot;
  const anchors = useMemo((): Anchor[] => {
    const out: Anchor[] = layout.rooms.map((r) => ({
      key: `room:${r.roomId}`,
      world: { ...r.label, y: 0.02 },
      className: `label3d${r.tiles.length < 4 ? ' small' : ''}${
        selection?.kind === 'room' && selection.roomId === r.roomId ? ' sel' : ''
      }`,
      text: r.name,
    }));
    for (const it of layout.items) {
      const top = itemTop(it.transform);
      const level = currentStatus(it.item, snapshot).level;
      if (level)
        out.push({
          key: `badge:${it.id}`,
          world: { ...top, y: top.y + 0.18 },
          className: `badge3d ${BADGE[level].tone}`,
          text: BADGE[level].glyph,
        });
      if (it.item.stale)
        out.push({
          key: `stale:${it.id}`,
          world: { ...top, y: top.y + 0.18 },
          className: 'badge3d stale',
          text: '?',
        });
      const named = it.id === hoverId || (selection?.kind === 'item' && selection.id === it.id);
      if (named)
        out.push({
          key: `name:${it.id}`,
          world: { ...top, y: top.y + 0.18 },
          className: 'name3d',
          text: it.item.name,
        });
    }
    for (const g of layout.ghosts) {
      const top = itemTop(g.transform);
      out.push({
        key: `ghost:${g.id}`,
        world: { ...top, y: top.y + 0.18 },
        className: 'badge3d ghost',
        text: 'note missing',
      });
    }
    return out;
  }, [layout, snapshot, selection, hoverId]);

  // Test hook (non-production builds only): exact screen positions for Playwright.
  const latest = useRef({ layout, vpNow });
  useLayoutEffect(() => {
    latest.current = { layout, vpNow };
  }, [layout, vpNow]);
  useEffect(() => {
    if (import.meta.env.MODE === 'production') return;
    const hook = window.__housebook;
    if (!hook) return;
    const toPage = (p: { x: number; y: number; z: number }) => {
      const el = viewport.current;
      const c = shown.current.cam;
      const vp = latest.current.vpNow();
      if (!el || !c || !vp) return null;
      const r = el.getBoundingClientRect();
      const s = project(c, vp, p);
      return { x: r.left + el.clientLeft + s.x, y: r.top + el.clientTop + s.y };
    };
    // Frame count when a model last arrived (or failed): settled only once it has been drawn.
    let modelFrame = -1;
    const unsubscribe = onModelChange(() => {
      modelFrame = shown.current.frames;
    });
    const statuses = () =>
      Object.fromEntries(latest.current.layout.items.map((i) => [i.id, modelStatus(i.item.type)]));
    const scene: SceneTestHook = {
      itemToScreen: (id) => {
        const it = latest.current.layout.items.find((i) => i.id === id);
        return it ? toPage(it.transform.position) : null;
      },
      cellToScreen: (x, y) => {
        const ts = latest.current.layout.tileSize;
        return toPage({ x: (x + 0.5) * ts, y: 0, z: (y + 0.5) * ts }) ?? { x: NaN, y: NaN };
      },
      camera: () => {
        const c = shown.current.cam ?? { x: NaN, z: NaN, zoom: NaN, angle: NaN };
        return { ...c, heading: heading(c.angle) };
      },
      // Settled only when the last drawn frame shows the latest goal at the current size:
      // a goal asked for but not drawn yet, a fit/focus waiting for the next frame, a viewport
      // that has resized (details panel) while the canvas hasn't caught up (react-three-fiber
      // measures ~50 ms later), all count as moving (M2-06).
      moving: () => {
        const s = shown.current;
        const goal = goalRef.current;
        const vp = latest.current.vpNow();
        const cv = canvasEl.current;
        return (
          s.moving ||
          s.frames <= modelFrame ||
          Object.values(statuses()).includes('loading') ||
          scheduled.current > 0 ||
          !s.cam ||
          !goal ||
          !s.goal ||
          !sameCamera(s.goal, goal) ||
          !sameCamera(s.cam, goal) ||
          !sameSize(s.size, vp) ||
          (!!cv && !sameSize({ width: cv.clientWidth, height: cv.clientHeight }, vp))
        );
      },
      frames: () => shown.current.frames,
      info: () => ({
        items: latest.current.layout.items.map((i) => i.id),
        wallTriangles: latest.current.layout.walls.length * 12,
        floorId: latest.current.layout.floorId,
        wallHeight: latest.current.layout.wallHeight,
      }),
      models: statuses,
    };
    hook.scene = scene;
    return () => {
      unsubscribe();
      if (hook.scene === scene) hook.scene = null;
    };
  }, []);

  // Said once zooming pauses, not on every wheel or pinch step.
  const zoomNow = cam ? Math.round(cam.goal.zoom) : null;
  const [zoomText, setZoomText] = useState('');
  useEffect(() => {
    if (zoomNow === null) return;
    const say = () => setZoomText(`Zoom ${zoomNow} pixels per metre`);
    const t = setTimeout(say, ZOOM_SAY_MS);
    return () => clearTimeout(t);
  }, [zoomNow]);

  const look = heading(cam?.goal.angle ?? 0);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const keys: Record<string, () => void> = {
      '+': () => move((c, vp, l) => zoomAt(c, 1.25, vp, undefined, undefined, l), false),
      '=': () => move((c, vp, l) => zoomAt(c, 1.25, vp, undefined, undefined, l), false),
      '-': () => move((c, vp, l) => zoomAt(c, 0.8, vp, undefined, undefined, l), false),
      '0': () => fit(false),
      '[': () => rotate(-1),
      ']': () => rotate(1),
      ArrowLeft: () => move((c) => panBy(c, PAN_STEP, 0), true),
      ArrowRight: () => move((c) => panBy(c, -PAN_STEP, 0), true),
      ArrowUp: () => move((c) => panBy(c, 0, PAN_STEP), true),
      ArrowDown: () => move((c) => panBy(c, 0, -PAN_STEP), true),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const selectedRoomId =
    selection?.kind === 'room' && selection.floorId === floorId ? selection.roomId : null;
  const name = floor.floor.name;

  return (
    <section ref={stage} className="stage" aria-label="3D view">
      <div className="floorbar">
        <FloorTabs floors={model.floors} current={floorId} />
        <div className="zoom" role="group" aria-label="3D camera">
          <button
            type="button"
            onClick={() => rotate(-1)}
            aria-label="Rotate view counter-clockwise"
            title="Rotate counter-clockwise ( [ )"
          >
            ⟲
          </button>
          <span className="compass" aria-live="polite" aria-atomic="true">
            <span className="sr-only">Looking </span>
            {look}
          </span>
          <button
            type="button"
            onClick={() => rotate(1)}
            aria-label="Rotate view clockwise"
            title="Rotate clockwise ( ] )"
          >
            ⟳
          </button>
          <button
            type="button"
            onClick={() => move((c, vp, l) => zoomAt(c, 0.8, vp, undefined, undefined, l), false)}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {zoomText}
          </span>
          <button
            type="button"
            onClick={() => move((c, vp, l) => zoomAt(c, 1.25, vp, undefined, undefined, l), false)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" className="fit" onClick={() => fit(false)}>
            Fit
          </button>
          <button
            type="button"
            className="fit"
            aria-pressed={wallsUp}
            onClick={() => setWallsUp((w) => !w)}
          >
            Walls up
          </button>
        </div>
      </div>
      <p id="scene3d-alt" className="sr-only">
        The 3D view is a picture only. The 2D plan and the List view show the same rooms and items
        as buttons you can reach with the keyboard and a screen reader.
      </p>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={viewport}
        className="viewport scene3d"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label={`3D view of ${name}, looking ${look}. Drag to pan, scroll or pinch to zoom. Keys: arrows pan, + and − zoom, 0 fits, [ and ] rotate.`}
        aria-describedby="scene3d-alt"
        data-floor-id={floorId}
        data-heading={look}
        data-walls={wallsUp ? 'up' : 'cut'}
        onKeyDown={onKeyDown}
        {...gestures}
      >
        {cam && (
          <Canvas
            orthographic
            frameloop="demand"
            flat
            dpr={[1, 2]}
            camera={{ zoom: cam.goal.zoom, near: 0.1, far: 400, position: [0, 50, 50] }}
            gl={{ antialias: true, alpha: true }}
            onCreated={({ gl }) => {
              renderer.current = gl;
              const el = gl.domElement;
              canvasEl.current = el;
              el.setAttribute('role', 'img');
              el.setAttribute(
                'aria-label',
                `3D picture of ${name}. Use the 2D plan or the List view for an accessible version.`,
              );
              el.addEventListener('webglcontextlost', onLost);
            }}
          >
            <CameraRig goal={cam.goal} instant={cam.instant} scene={sphere} onFrame={onFrame} />
            <SceneContent
              layout={layout}
              cells={floor.cells}
              heading={look}
              snapshot={model.snapshot}
              palette={palette}
              selectedItemId={selectedId}
              selectedRoomId={selectedRoomId}
              matches={search.active ? search.matches : null}
              hoverId={hoverId}
              onHover={onHover}
              onItem={onItem}
              onRoom={onRoom}
            />
          </Canvas>
        )}
        <SceneOverlays anchors={anchors} handle={overlays} view={lastView} />
      </div>
    </section>
  );
}
