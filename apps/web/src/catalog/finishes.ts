// Floor and wall finishes from the shared contract (contract/finishes.json, D41). Pure data and
// lookups; the views decide how a finish is drawn.
import finishesJson from '@contract/finishes.json';

export interface Finish {
  key: string;
  label: string;
  group?: string;
  /** Average colour: the flat home look, and what a texture falls back to. */
  color: string;
}

export interface Paint {
  label: string;
  color: string;
}

const data = finishesJson as {
  floors: Finish[];
  wallpapers: Finish[];
  paints: Paint[];
  exteriorDefault: string;
};

const floors = new Map(data.floors.map((f) => [f.key, f]));
const wallpapers = new Map(data.wallpapers.map((w) => [w.key, w]));

export const floorFinishes = (): readonly Finish[] => data.floors;
export const wallpaperFinishes = (): readonly Finish[] => data.wallpapers;
export const paintPalette = (): readonly Paint[] => data.paints;
/** Outside walls when the house has no `exteriorWallColor`. */
export const EXTERIOR_DEFAULT = data.exteriorDefault;

/** The floor finish of a room, or undefined (none chosen, or a key this version doesn't know). */
export const floorFinish = (key: string | null | undefined): Finish | undefined =>
  key ? floors.get(key) : undefined;

const HEX = /^#[0-9a-f]{6}$/i;

export type WallFinish = { kind: 'paint'; color: string } | { kind: 'wallpaper'; finish: Finish };

/** A room's `walls` value read: a paint colour or a known wallpaper; undefined otherwise. */
export function wallFinish(value: string | null | undefined): WallFinish | undefined {
  if (!value) return undefined;
  if (HEX.test(value)) return { kind: 'paint', color: value };
  const w = wallpapers.get(value);
  return w ? { kind: 'wallpaper', finish: w } : undefined;
}

/** The colour a wall finish is drawn with in the flat look. */
export const wallFinishColor = (w: WallFinish): string =>
  w.kind === 'paint' ? w.color : w.finish.color;

/** Short text for a wall finish: "Sage", "#a1b2c3", "Stripes wallpaper". */
export function wallFinishLabel(w: WallFinish): string {
  if (w.kind === 'wallpaper') return `${w.finish.label} wallpaper`;
  const named = data.paints.find((p) => p.color.toLowerCase() === w.color.toLowerCase());
  return named ? named.label : w.color.toLowerCase();
}
