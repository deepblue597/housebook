import { OrthographicCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  type CameraState,
  FOCUS_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  basis,
  boxSphere,
  cameraDepth,
  fitBox,
  focusOn,
  heading,
  panBy,
  project,
  rotateBy,
  sameCamera,
  screenToGround,
  stepToward,
  zoomAt,
  zoomLimits,
} from './camera';
import { applyCamera } from './rig';

const vp = { width: 800, height: 600 };
const cam: CameraState = { x: 8, z: 4.5, zoom: 50, angle: 0 };
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** What three.js itself draws: the camera set up by CameraRig, projected to CSS pixels. */
function threeProject(c: CameraState, p: { x: number; y: number; z: number }) {
  const camera = new OrthographicCamera(-vp.width / 2, vp.width / 2, vp.height / 2, -vp.height / 2);
  applyCamera(camera, c, boxSphere({ min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 2.5, z: 9 } }));
  const v = new Vector3(p.x, p.y, p.z).project(camera);
  return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height };
}

describe('camera basis', () => {
  it.each([0, 90, 180, 270, -90, 450])('is orthonormal at %i°', (angle) => {
    const b = basis(angle);
    for (const v of [b.right, b.up, b.back]) expect(dot(v, v)).toBeCloseTo(1, 12);
    expect(dot(b.right, b.up)).toBeCloseTo(0, 12);
    expect(dot(b.right, b.back)).toBeCloseTo(0, 12);
    expect(dot(b.up, b.back)).toBeCloseTo(0, 12);
  });

  it('looking north: east is screen right, south is towards the viewer (as in the 2D plan)', () => {
    const b = basis(0);
    expect(b.right).toEqual([1, 0, 0]);
    expect(b.forward).toEqual([0, 0, -1]);
    expect(b.back[2]).toBeGreaterThan(0); // the camera stands south of its target
    expect(b.back[1]).toBeGreaterThan(0); // and above it
  });

  it('names the heading', () => {
    expect([0, 90, 180, 270, -90, 360, 44].map(heading)).toEqual([
      'north',
      'east',
      'south',
      'west',
      'west',
      'north',
      'north',
    ]);
  });
});

describe('projection matches three.js (pointer ↔ world without WebGL)', () => {
  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 8, y: 0, z: 4.5 },
    { x: 15.5, y: 1, z: 9.25 },
    { x: 3.2, y: 2.5, z: 0.4 },
  ];
  for (const angle of [0, 90, 180, 270, -450]) {
    it(`at ${angle}°`, () => {
      const c = { ...cam, angle };
      for (const p of points) {
        const mine = project(c, vp, p);
        const theirs = threeProject(c, p);
        expect(mine.x).toBeCloseTo(theirs.x, 6);
        expect(mine.y).toBeCloseTo(theirs.y, 6);
      }
    });
  }

  it('the look-at point is the viewport centre', () => {
    expect(project(cam, vp, { x: cam.x, y: 0, z: cam.z })).toEqual({ x: 400, y: 300 });
  });

  it('screenToGround inverts project on the floor plane', () => {
    for (const angle of [0, 90, 180, 270]) {
      const c = { ...cam, angle, zoom: 37 };
      for (const p of [
        { x: 1, z: 2 },
        { x: 12.3, z: 7.7 },
      ]) {
        const s = project(c, vp, { x: p.x, y: 0, z: p.z });
        const g = screenToGround(c, vp, s.x, s.y);
        expect(g.x).toBeCloseTo(p.x, 9);
        expect(g.z).toBeCloseTo(p.z, 9);
      }
    }
  });
});

describe('pan, zoom, rotate', () => {
  it('panning drags the floor point under the pointer along', () => {
    for (const angle of [0, 90, 180, 270]) {
      const c = { ...cam, angle };
      const g = screenToGround(c, vp, 200, 150);
      const moved = panBy(c, 35, -20);
      const s = project(moved, vp, { x: g.x, y: 0, z: g.z });
      expect(s.x).toBeCloseTo(235, 9);
      expect(s.y).toBeCloseTo(130, 9);
    }
  });

  it('zooming keeps the point under the cursor fixed and clamps', () => {
    const g = screenToGround(cam, vp, 600, 100);
    const z = zoomAt(cam, 1.5, vp, 600, 100);
    expect(z.zoom).toBe(75);
    const s = project(z, vp, { x: g.x, y: 0, z: g.z });
    expect(s.x).toBeCloseTo(600, 9);
    expect(s.y).toBeCloseTo(100, 9);
    expect(zoomAt(cam, 1000, vp).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, 1e-6, vp).zoom).toBe(MIN_ZOOM);
    // Without a point it zooms about the centre: the target doesn't move.
    const c = zoomAt(cam, 2, vp);
    expect([c.x, c.z]).toEqual([cam.x, cam.z]);
  });

  it('rotates in 90° steps only, about the look-at point', () => {
    const r = rotateBy(cam, 1);
    expect(r).toEqual({ ...cam, angle: -90 });
    expect(heading(r.angle)).toBe('west'); // house turned clockwise: north is now on the right
    expect(heading(rotateBy(r, 1).angle)).toBe('south');
    expect(rotateBy(cam, -1).angle).toBe(90);
    // A step from a half-finished tween snaps to the grid of 90° headings.
    expect(rotateBy({ ...cam, angle: -47 }, 1).angle).toBe(-180);
  });

  it('clockwise rotation puts north on the right of the screen', () => {
    const r = rotateBy(cam, 1);
    const centre = project(r, vp, { x: cam.x, y: 0, z: cam.z });
    const north = project(r, vp, { x: cam.x, y: 0, z: cam.z - 1 });
    expect(north.x).toBeGreaterThan(centre.x);
    expect(north.y).toBeCloseTo(centre.y, 9);
  });
});

describe('framing', () => {
  const box = { min: { x: 1, y: 0, z: 1 }, max: { x: 15, y: 1, z: 9 } };

  it.each([0, 90, 180, 270])('fitBox shows the whole box at %i°, filling one axis', (angle) => {
    const c = fitBox(box, angle, vp);
    expect(c.angle).toBe(angle);
    const corners = [];
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) corners.push(project(c, vp, { x, y, z }));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(23.999);
    expect(Math.max(...xs)).toBeLessThanOrEqual(776.001);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(23.999);
    expect(Math.max(...ys)).toBeLessThanOrEqual(576.001);
    // Centred, and tight on at least one axis.
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(400, 6);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(300, 6);
    const tight =
      Math.abs(Math.max(...xs) - Math.min(...xs) - 752) < 1e-6 ||
      Math.abs(Math.max(...ys) - Math.min(...ys) - 552) < 1e-6;
    expect(tight).toBe(true);
  });

  it('focusOn centres an item, also one above the floor, zooming in if needed', () => {
    for (const angle of [0, 90, 180, 270]) {
      const p = { x: 10.5, y: 1.6, z: 2.25 };
      const c = focusOn({ ...cam, angle, zoom: 20 }, p);
      const s = project(c, vp, p);
      expect(s.x).toBeCloseTo(400, 9);
      expect(s.y).toBeCloseTo(300, 9);
      expect(c.zoom).toBe(FOCUS_ZOOM);
      expect(c.angle).toBe(angle);
    }
    expect(focusOn({ ...cam, zoom: 200 }, { x: 0, y: 0, z: 0 }).zoom).toBe(200);
  });
});

describe('camera easing', () => {
  it('converges to the goal and then reports done', () => {
    const goal = { x: 2, z: 3, zoom: 120, angle: -90 };
    let cur: CameraState = cam;
    let frames = 0;
    for (; frames < 200; frames++) {
      const s = stepToward(cur, goal, 1 / 60);
      cur = s.state;
      if (s.done) break;
    }
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(120);
    expect(sameCamera(cur, goal)).toBe(true);
  });

  it('a zero time step does not move', () => {
    const s = stepToward(cam, { ...cam, x: 9 }, 0).state;
    expect(s.x).toBe(cam.x);
    expect(s.zoom).toBeCloseTo(cam.zoom, 9);
  });
});

describe('extreme grids (contract: up to 512 × 512 tiles, tileSize up to 10 m)', () => {
  const grids = [
    { name: 'largest', w: 512, d: 512, ts: 10 },
    { name: 'long and thin', w: 512, d: 1, ts: 10 },
    { name: 'smallest', w: 1, d: 1, ts: 0.05 },
    { name: 'example', w: 16, d: 9, ts: 1 },
  ];
  const phone = { width: 360, height: 420 };

  for (const g of grids) {
    const box = { min: { x: 0, y: 0, z: 0 }, max: { x: g.w * g.ts, y: 2.5, z: g.d * g.ts } };
    const sphere = boxSphere(box);
    const limits = zoomLimits(sphere, g.ts);
    const corners = () => {
      const out = [];
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) out.push({ x, y, z });
      return out;
    };

    it.each([0, 90, 180, 270])(`${g.name}: the whole grid fits a phone at %i°`, (angle) => {
      const c = fitBox(box, angle, phone, limits);
      expect(c.zoom).toBeGreaterThanOrEqual(limits.min);
      for (const p of corners()) {
        const s = project(c, phone, p);
        expect(s.x).toBeGreaterThanOrEqual(-1e-6);
        expect(s.x).toBeLessThanOrEqual(phone.width + 1e-6);
        expect(s.y).toBeGreaterThanOrEqual(-1e-6);
        expect(s.y).toBeLessThanOrEqual(phone.height + 1e-6);
      }
      // And zooming out from the fit still works (the limit is below it).
      expect(zoomAt(c, 0.5, phone, undefined, undefined, limits).zoom).toBeLessThan(c.zoom);
    });

    it(`${g.name}: one tile can fill the screen when zoomed all the way in`, () => {
      expect(limits.max * g.ts).toBeGreaterThanOrEqual(300);
    });

    it(`${g.name}: nothing is clipped, wherever the camera is panned`, () => {
      const span = Math.max(g.w, g.d) * g.ts;
      for (const angle of [0, 90, 180, 270])
        for (const [x, z] of [
          [0, 0],
          [box.max.x / 2, box.max.z / 2],
          [box.max.x, box.max.z],
          [-span, 2 * span], // panned well off the grid
        ] as const) {
          const c: CameraState = { x, z, zoom: 1, angle };
          const camera = new OrthographicCamera(-180, 180, 210, -210);
          applyCamera(camera, c, sphere);
          const { near, far } = cameraDepth(c, sphere);
          for (const p of corners()) {
            // Depth along the view direction, from the camera.
            const v = new Vector3(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
            expect(-v.z).toBeGreaterThan(near);
            expect(-v.z).toBeLessThan(far);
          }
        }
    });
  }
});
