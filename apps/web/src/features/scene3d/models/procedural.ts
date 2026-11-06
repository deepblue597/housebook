/**
 * Low-poly models built from primitives for the catalogue types no CC0 model fits (no
 * dishwasher, boiler, valve, fuse box… in the Kenney kit). Same look as the kit: flat colours,
 * chunky shapes. Authored in metres, standing on y = 0, front facing +z; fitModel() scales and
 * places them like the GLB models.
 */
import { BoxGeometry, type BufferGeometry, CylinderGeometry } from 'three';
import { type ModelTemplate, makeTemplate } from './template';

type Part = { name: string; geometry: BufferGeometry; color: string; outline?: boolean };

const WHITE = '#e9ecee';
const LIGHT = '#d6dde1';
const GREY = '#9aa5ad';
const DARK = '#2e3a40';
const METAL = '#b9c4c9';
const COPPER = '#c7895b';

function box(name: string, color: string, w: number, h: number, d: number, at: number[]): Part {
  const g = new BoxGeometry(w, h, d);
  g.translate(at[0]!, at[1]!, at[2]!);
  return { name, geometry: g, color };
}

/** A cylinder of radius r and length l along `axis`, centred at `at`. */
function cyl(
  name: string,
  color: string,
  r: number,
  l: number,
  at: number[],
  axis: 'x' | 'y' | 'z' = 'y',
  segments = 12,
): Part {
  const g = new CylinderGeometry(r, r, l, segments);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(at[0]!, at[1]!, at[2]!);
  return { name, geometry: g, color };
}

const BUILDERS: Record<string, () => Part[]> = {
  dishwasher: () => [
    box('body', WHITE, 0.6, 0.82, 0.58, [0, 0.43, 0]),
    box('plinth', DARK, 0.56, 0.06, 0.52, [0, 0.03, -0.02]),
    box('door', '#c9d1d6', 0.56, 0.62, 0.012, [0, 0.4, 0.296]),
    box('panel', GREY, 0.6, 0.1, 0.02, [0, 0.79, 0.3]),
    box('display', DARK, 0.14, 0.04, 0.01, [0.16, 0.79, 0.315]),
    box('handle', METAL, 0.36, 0.025, 0.03, [0, 0.69, 0.305]),
  ],
  ac: () => [
    box('body', WHITE, 0.8, 0.26, 0.2, [0, 0.13, 0]),
    box('top', LIGHT, 0.8, 0.04, 0.2, [0, 0.27, 0]),
    box('vent', DARK, 0.7, 0.04, 0.02, [0, 0.05, 0.1]),
    box('led', '#4fc06b', 0.03, 0.015, 0.01, [0.32, 0.17, 0.105]),
  ],
  heater: () => [
    cyl('tank', WHITE, 0.22, 0.72, [0, 0.42, 0], 'y', 20),
    cyl('cap', LIGHT, 0.2, 0.04, [0, 0.8, 0], 'y', 20),
    box('dial', DARK, 0.1, 0.1, 0.02, [0, 0.42, 0.22]),
    cyl('pipe-in', COPPER, 0.02, 0.06, [-0.08, 0.03, 0], 'y'),
    cyl('pipe-out', COPPER, 0.02, 0.06, [0.08, 0.03, 0], 'y'),
  ],
  boiler: () => [
    box('body', WHITE, 0.42, 0.66, 0.3, [0, 0.39, 0]),
    box('panel', LIGHT, 0.42, 0.14, 0.02, [0, 0.14, 0.16]),
    box('display', DARK, 0.12, 0.05, 0.01, [0, 0.15, 0.175]),
    cyl('pipe-a', COPPER, 0.015, 0.06, [-0.12, 0.03, -0.04], 'y'),
    cyl('pipe-b', COPPER, 0.015, 0.06, [-0.04, 0.03, -0.04], 'y'),
    cyl('pipe-c', COPPER, 0.015, 0.06, [0.04, 0.03, -0.04], 'y'),
    cyl('pipe-d', COPPER, 0.015, 0.06, [0.12, 0.03, -0.04], 'y'),
  ],
  radiator: () => {
    const fins: Part[] = [];
    for (let i = 0; i < 9; i++) {
      fins.push(box(`fin${i}`, WHITE, 0.07, 0.56, 0.08, [-0.36 + i * 0.09, 0.3, 0]));
    }
    return [
      ...fins,
      cyl('top', LIGHT, 0.02, 0.82, [0, 0.55, 0], 'x'),
      cyl('bottom', LIGHT, 0.02, 0.82, [0, 0.05, 0], 'x'),
      cyl('valve', METAL, 0.025, 0.05, [0.43, 0.05, 0], 'y'),
    ];
  },
  router: () => [
    box('body', DARK, 0.28, 0.05, 0.18, [0, 0.03, 0]),
    box('leds', '#4fc06b', 0.16, 0.008, 0.005, [0, 0.03, 0.093]),
    cyl('antenna-l', DARK, 0.008, 0.16, [-0.11, 0.13, -0.08]),
    cyl('antenna-r', DARK, 0.008, 0.16, [0.11, 0.13, -0.08]),
  ],
  // Main water valve: a blue-painted body with a blue lever on the pipe.
  valve: () => [
    cyl('pipe', METAL, 0.028, 0.3, [0, 0.06, 0], 'x'),
    box('body', '#3f7fc4', 0.11, 0.1, 0.1, [0, 0.07, 0]),
    cyl('stem', METAL, 0.01, 0.03, [0, 0.135, 0]),
    box('lever', '#3f7fc4', 0.16, 0.02, 0.04, [0.05, 0.155, 0]),
  ],
  gas_valve: () => [
    cyl('pipe', METAL, 0.02, 0.28, [0, 0.04, 0], 'x'),
    box('body', '#b08d3a', 0.07, 0.06, 0.06, [0, 0.04, 0]),
    cyl('stem', METAL, 0.007, 0.03, [0, 0.03, 0.04], 'z'),
    box('lever', '#e0b03c', 0.12, 0.025, 0.012, [0.04, 0.04, 0.06]),
  ],
  fuse: () => [
    box('body', LIGHT, 0.42, 0.5, 0.1, [0, 0.25, 0]),
    box('door', '#c3ccd2', 0.38, 0.46, 0.015, [0, 0.25, 0.055]),
    box('window', DARK, 0.3, 0.07, 0.008, [0, 0.33, 0.065]),
    box('latch', GREY, 0.04, 0.06, 0.012, [0.15, 0.2, 0.068]),
  ],
  smoke: () => [
    cyl('base', WHITE, 0.07, 0.015, [0, 0.0475, 0], 'y', 20),
    cyl('body', WHITE, 0.065, 0.035, [0, 0.0225, 0], 'y', 20),
    cyl('led', '#d9534f', 0.008, 0.006, [0.03, 0.002, 0.02], 'y', 8),
  ],
  // Unknown types and `other`: a neutral cabinet, clearly "something here".
  other: () => [
    box('body', '#cfc6bc', 0.5, 0.45, 0.5, [0, 0.275, 0]),
    box('plinth', '#8f857a', 0.46, 0.05, 0.46, [0, 0.025, 0]),
    box('front', '#b8ada1', 0.4, 0.33, 0.015, [0, 0.27, 0.255]),
  ],
};

/** Types drawn from primitives. */
export const PROCEDURAL_TYPES: readonly string[] = Object.keys(BUILDERS);

const cache = new Map<string, ModelTemplate>();

/** The procedural model for `type` (built once, shared); unknown types get `other`. */
export function proceduralModel(type: string): ModelTemplate {
  const key = type in BUILDERS ? type : 'other';
  let t = cache.get(key);
  if (!t) {
    t = makeTemplate('procedural', BUILDERS[key]!());
    cache.set(key, t);
  }
  return t;
}
