/**
 * Item type → the box a 3D model is fitted into: real-world height (and depth for wall and
 * ceiling items) per type, the width from the catalogue footprint. The model itself (CC0 GLB
 * or procedural) is picked in features/scene3d/models (lazy 3D chunk); the box is also the
 * fallback drawn when a model can't be loaded.
 */
import type { ItemShape } from '../domain/scene';
import { itemType, placementSpec } from './catalog';

export interface ModelSpec extends ItemShape {
  /** Type tint: the fallback box's colour, and a subtle hint on the model's colours. */
  tint: string;
}

const KITCHEN = '#d9dee3';
const LAUNDRY = '#c9d6e8';
const HEAT = '#e8b48a';
const TECH = '#7d8a96';
const SAFETY = '#d9534f';
const OTHER = '#b8a99a';

const MODELS: Record<string, ModelSpec> = {
  fridge: { height: 1.8, tint: KITCHEN },
  oven: { height: 0.9, tint: KITCHEN },
  dishwasher: { height: 0.85, tint: KITCHEN },
  washer: { height: 0.85, tint: LAUNDRY },
  dryer: { height: 0.85, tint: LAUNDRY },
  microwave: { height: 0.35, tint: KITCHEN, fill: 0.55 },
  ac: { height: 0.3, depth: 0.25, tint: '#eef1f4' },
  heater: { height: 0.8, depth: 0.45, tint: HEAT, fill: 0.5 },
  boiler: { height: 0.7, depth: 0.35, tint: HEAT, fill: 0.5 },
  radiator: { height: 0.6, depth: 0.1, tint: HEAT },
  tv: { height: 0.55, depth: 0.15, tint: '#2f3a40' },
  router: { height: 0.2, tint: TECH, fill: 0.35 },
  computer: { height: 0.5, tint: TECH, fill: 0.7 },
  laptop: { height: 0.25, tint: TECH, fill: 0.45 },
  valve: { height: 0.15, tint: '#4f86c6', fill: 0.3 },
  gas_valve: { height: 0.15, depth: 0.12, tint: '#e0b03c', fill: 0.3 },
  fuse: { height: 0.5, depth: 0.12, tint: TECH, fill: 0.45 },
  smoke: { height: 0.06, depth: 0.15, tint: SAFETY, fill: 0.15 },
  other: { height: 0.5, tint: OTHER, fill: 0.6 },
};

/** Model spec for any type key or alias; unknown types get the generic box. */
export function modelSpec(type: string | null | undefined): ModelSpec {
  return MODELS[itemType(type)?.key ?? 'other'] ?? MODELS.other!;
}

export { placementSpec };
