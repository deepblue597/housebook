/**
 * Catalogue type → model (DESIGN §7.5). GLB files are CC0 (src/assets/models/LICENSES.md),
 * imported with `?url` so Vite content-hashes them (served immutable) and nothing is fetched
 * until the 3D view draws an item of that type. This module is only imported by the lazy 3D
 * chunk. `yaw` turns a model authored facing another way so its front faces +z.
 */
import computerUrl from '../../../assets/models/computer.glb?url';
import doorFrameUrl from '../../../assets/models/door-frame.glb?url';
import doorLeafUrl from '../../../assets/models/door-leaf.glb?url';
import dryerUrl from '../../../assets/models/dryer.glb?url';
import frontDoorLeafUrl from '../../../assets/models/front-door-leaf.glb?url';
import fridgeUrl from '../../../assets/models/fridge.glb?url';
import laptopUrl from '../../../assets/models/laptop.glb?url';
import microwaveUrl from '../../../assets/models/microwave.glb?url';
import ovenUrl from '../../../assets/models/oven.glb?url';
import tvUrl from '../../../assets/models/tv.glb?url';
import washerUrl from '../../../assets/models/washer.glb?url';
import windowUrl from '../../../assets/models/window.glb?url';
import { itemType } from '../../../catalog/catalog';
import type { Yaw } from './normalise';
import { PROCEDURAL_TYPES } from './procedural';

export interface GlbSource {
  kind: 'glb';
  /** Catalogue key. */
  type: string;
  url: string;
  yaw: Yaw;
}
export interface ProceduralSource {
  kind: 'procedural';
  /** Builder key (`other` for unknown types). */
  type: string;
}
export type ModelSource = GlbSource | ProceduralSource;

/** Kenney Furniture Kit models are authored facing −z. */
const KENNEY: Yaw = 180;

export const GLB_MODELS: Readonly<Record<string, Omit<GlbSource, 'kind' | 'type'>>> = {
  fridge: { url: fridgeUrl, yaw: KENNEY },
  oven: { url: ovenUrl, yaw: KENNEY },
  washer: { url: washerUrl, yaw: KENNEY },
  dryer: { url: dryerUrl, yaw: KENNEY },
  microwave: { url: microwaveUrl, yaw: KENNEY },
  tv: { url: tvUrl, yaw: KENNEY },
  computer: { url: computerUrl, yaw: KENNEY },
  laptop: { url: laptopUrl, yaw: KENNEY },
};

/**
 * Door and window parts (D37), drawn in the wall gaps rather than as items. The door frame and
 * leaves come from the same kit model, so a leaf sits in the frame as authored.
 */
export const OPENING_MODELS = {
  doorFrame: { kind: 'glb', type: 'door-frame', url: doorFrameUrl, yaw: KENNEY },
  doorLeaf: { kind: 'glb', type: 'door-leaf', url: doorLeafUrl, yaw: KENNEY },
  frontDoorLeaf: { kind: 'glb', type: 'front-door-leaf', url: frontDoorLeafUrl, yaw: KENNEY },
  window: { kind: 'glb', type: 'window', url: windowUrl, yaw: KENNEY },
} as const satisfies Record<string, GlbSource>;

/** The model for a type key or alias; unknown types get the neutral `other` model. */
export function modelSource(type: string | null | undefined): ModelSource {
  const key = itemType(type)?.key ?? 'other';
  const glb = GLB_MODELS[key];
  if (glb) return { kind: 'glb', type: key, ...glb };
  return { kind: 'procedural', type: PROCEDURAL_TYPES.includes(key) ? key : 'other' };
}
