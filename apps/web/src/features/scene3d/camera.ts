/**
 * Camera for the 3D view (DESIGN §7.4, D5): orthographic, tilted ~45°, panned on the floor
 * plane, zoomed, and rotated in 90° steps only. Pure math on plain numbers, so pointer → floor,
 * fitting and focusing are unit-tested without WebGL; CameraRig applies the result to three.
 *
 * `angle` is the compass heading the camera looks along, in degrees clockwise from north
 * (0 = looking north, so +y/south is towards the viewer as in the 2D plan). `zoom` is screen
 * pixels per metre, which is exactly three's OrthographicCamera.zoom in react-three-fiber.
 */

export const ELEVATION_DEG = 45;
/** Default zoom limits (px per metre); `zoomLimits` widens them for very large or small grids. */
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 400;
/** Focusing an item zooms in to at least this (px per metre). */
export const FOCUS_ZOOM = 70;
const FIT_PAD = 24;

export interface CameraState {
  /** Point on the floor plane the camera looks at (world x, z). */
  x: number;
  z: number;
  zoom: number;
  angle: number;
}

export interface Viewport {
  width: number;
  height: number;
}

type V3 = [number, number, number];

export interface Basis {
  /** Screen right. */
  right: V3;
  /** Screen up. */
  up: V3;
  /** Horizontal look direction. */
  forward: V3;
  /** From the target towards the camera (unit). */
  back: V3;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

export interface ZoomLimits {
  min: number;
  max: number;
}
export const DEFAULT_LIMITS: ZoomLimits = { min: MIN_ZOOM, max: MAX_ZOOM };

/** A sphere around everything that can be drawn (the whole grid, up to the ceiling). */
export interface SceneSphere {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** The sphere around a world box. */
export function boxSphere(box: {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}): SceneSphere {
  const [dx, dy, dz] = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
    radius: Math.max(0.5, Math.hypot(dx, dy, dz) / 2),
  };
}

/**
 * Zoom limits for a scene: zooming out goes at least far enough that the whole scene fits in
 * ~100 px (the contract's largest grid, 512 tiles of 10 m, is 7 km across), and zooming in at
 * least far enough that one tile fills ~300 px (tiles can be a few centimetres).
 */
export function zoomLimits(sphere: SceneSphere, tileSize: number): ZoomLimits {
  return {
    min: Math.min(MIN_ZOOM, 100 / (2 * sphere.radius)),
    max: Math.max(MAX_ZOOM, 300 / Math.max(1e-3, tileSize)),
  };
}

/**
 * How far the camera stands back from its look-at point, and its clipping planes, so nothing in
 * `sphere` is clipped wherever the camera has been panned (orthographic: distance changes
 * nothing on screen, only what lies between near and far).
 */
export function cameraDepth(
  c: CameraState,
  sphere: SceneSphere,
): { distance: number; near: number; far: number } {
  // The scene lies within `reach` of the look-at point (which sits on the floor plane).
  const reach = Math.hypot(c.x - sphere.x, sphere.y, c.z - sphere.z) + sphere.radius;
  const distance = Math.max(100, reach + 10);
  return { distance, near: 0.1, far: distance + reach + 10 };
}

const clamp = (k: number, l: ZoomLimits) => Math.min(l.max, Math.max(l.min, k));
/** Avoid -0 in results (it only confuses equality checks). */
const n0 = (v: number) => (Object.is(v, -0) || Math.abs(v) < 1e-12 ? 0 : v);

export function basis(angle: number, elevation = ELEVATION_DEG): Basis {
  const a = rad(angle);
  const e = rad(elevation);
  const sa = n0(Math.sin(a));
  const ca = n0(Math.cos(a));
  const se = Math.sin(e);
  const ce = Math.cos(e);
  return {
    right: [ca, 0, sa],
    up: [n0(sa * se), ce, n0(-ca * se)],
    forward: [sa, 0, n0(-ca)],
    back: [n0(-sa * ce), se, n0(ca * ce)],
  };
}

/** Compass name of the direction the camera looks (angle snapped to 90°). */
export function heading(angle: number): 'north' | 'east' | 'south' | 'west' {
  const q = ((Math.round(angle / 90) % 4) + 4) % 4;
  return (['north', 'east', 'south', 'west'] as const)[q]!;
}

/** Where the camera sits and what it looks at, `distance` metres from the target. */
export function cameraPose(c: CameraState, distance = 100) {
  const { back } = basis(c.angle);
  return {
    position: [c.x + back[0] * distance, back[1] * distance, c.z + back[2] * distance] as V3,
    target: [c.x, 0, c.z] as V3,
  };
}

/** World point → CSS pixels inside the viewport (orthographic, so depth doesn't matter). */
export function project(
  c: CameraState,
  vp: Viewport,
  p: { x: number; y: number; z: number },
): { x: number; y: number } {
  const { right, up } = basis(c.angle);
  const d = [p.x - c.x, p.y, p.z - c.z];
  return { x: vp.width / 2 + dot(d, right) * c.zoom, y: vp.height / 2 - dot(d, up) * c.zoom };
}

/** CSS pixel inside the viewport → the floor-plane point under it (y = 0). */
export function screenToGround(
  c: CameraState,
  vp: Viewport,
  px: number,
  py: number,
): { x: number; z: number } {
  const { right, forward } = basis(c.angle);
  const a = (px - vp.width / 2) / c.zoom;
  const b = -(py - vp.height / 2) / (c.zoom * Math.sin(rad(ELEVATION_DEG)));
  return { x: c.x + right[0] * a + forward[0] * b, z: c.z + right[2] * a + forward[2] * b };
}

/** Drag by (dx, dy) CSS pixels: the floor under the pointer follows it. */
export function panBy(c: CameraState, dx: number, dy: number): CameraState {
  const { right, forward } = basis(c.angle);
  const a = -dx / c.zoom;
  const b = dy / (c.zoom * Math.sin(rad(ELEVATION_DEG)));
  return { ...c, x: c.x + right[0] * a + forward[0] * b, z: c.z + right[2] * a + forward[2] * b };
}

/** Zoom by `factor`, keeping the floor point under (px, py) fixed on screen. */
export function zoomAt(
  c: CameraState,
  factor: number,
  vp: Viewport,
  px = vp.width / 2,
  py = vp.height / 2,
  limits: ZoomLimits = DEFAULT_LIMITS,
): CameraState {
  const zoom = clamp(c.zoom * factor, limits);
  const g = screenToGround(c, vp, px, py);
  const f = c.zoom / zoom;
  return { ...c, zoom, x: g.x - (g.x - c.x) * f, z: g.z - (g.z - c.z) * f };
}

/**
 * Turn the view in 90° steps. `+1` turns the house clockwise on screen (the camera turns
 * to look further west), `-1` counter-clockwise. The look-at point stays put.
 */
export function rotateBy(c: CameraState, steps: number): CameraState {
  const snapped = Math.round(c.angle / 90) * 90;
  return { ...c, angle: snapped - steps * 90 };
}

/** Centre `p` on screen, zooming in to at least FOCUS_ZOOM. */
export function focusOn(
  c: CameraState,
  p: { x: number; y: number; z: number },
  limits: ZoomLimits = DEFAULT_LIMITS,
): CameraState {
  const { forward } = basis(c.angle);
  // The look-at point is on the floor; p is `y` above it, so shift along the view direction.
  const k = p.y / Math.tan(rad(ELEVATION_DEG));
  return {
    ...c,
    x: p.x + forward[0] * k,
    z: p.z + forward[2] * k,
    zoom: Math.max(c.zoom, Math.min(limits.max, FOCUS_ZOOM)),
  };
}

/** Fit a world box (metres) into the viewport at the given heading. */
export function fitBox(
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  angle: number,
  vp: Viewport,
  limits: ZoomLimits = DEFAULT_LIMITS,
): CameraState {
  const { right, up, forward } = basis(angle);
  let [sx0, sx1, sy0, sy1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const sx = dot([x, y, z], right);
        const sy = dot([x, y, z], up);
        [sx0, sx1, sy0, sy1] = [
          Math.min(sx0, sx),
          Math.max(sx1, sx),
          Math.min(sy0, sy),
          Math.max(sy1, sy),
        ];
      }
  const w = Math.max(1, vp.width - 2 * FIT_PAD);
  const h = Math.max(1, vp.height - 2 * FIT_PAD);
  const zoom = clamp(
    Math.min(w / Math.max(1e-6, sx1 - sx0), h / Math.max(1e-6, sy1 - sy0)),
    limits,
  );
  // The floor point whose projection is the box's screen centre.
  const cx = (sx0 + sx1) / 2;
  const cy = (sy0 + sy1) / 2 / Math.sin(rad(ELEVATION_DEG));
  return {
    x: n0(right[0] * cx + forward[0] * cy),
    z: n0(right[2] * cx + forward[2] * cy),
    zoom,
    angle,
  };
}

/**
 * One frame of a camera move towards `goal` (exponential ease; zoom eases in log space).
 * Returns the goal itself once close enough, so the caller can stop requesting frames.
 */
export function stepToward(
  cur: CameraState,
  goal: CameraState,
  dt: number,
  rate = 14,
): { state: CameraState; done: boolean } {
  const t = 1 - Math.exp(-rate * Math.max(0, dt));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const next = {
    x: lerp(cur.x, goal.x),
    z: lerp(cur.z, goal.z),
    zoom: Math.exp(lerp(Math.log(cur.zoom), Math.log(goal.zoom))),
    angle: lerp(cur.angle, goal.angle),
  };
  const close =
    Math.abs(next.angle - goal.angle) < 0.05 &&
    Math.abs(Math.log(next.zoom / goal.zoom)) < 1e-3 &&
    Math.hypot(next.x - goal.x, next.z - goal.z) * goal.zoom < 0.25;
  return close ? { state: goal, done: true } : { state: next, done: false };
}

export const sameCamera = (a: CameraState, b: CameraState): boolean =>
  a.x === b.x && a.z === b.z && a.zoom === b.zoom && a.angle === b.angle;
