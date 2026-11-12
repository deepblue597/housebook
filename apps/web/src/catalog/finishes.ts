// Floor and wall finishes from the shared contract (contract/finishes.json, D41), plus the
// household's own textures from the snapshot (D43). Pure data and lookups; the views decide how
// a finish is drawn.
import finishesJson from '@contract/finishes.json';
import type { OwnTexture } from '../api/types';

export interface Finish {
  key: string;
  label: string;
  group?: string;
  /** Average colour of the texture: what is drawn while it loads, or if it fails. */
  color: string;
  /** File in src/assets/textures (D42). */
  texture?: string;
  /** Metres the texture covers before it repeats, [x, y]. */
  size?: readonly [number, number];
  /** An uploaded texture (D43): its image URL from the server (none if the file is missing). */
  own?: { url: string | null };
}

/** A finish's texture: its URL (fetched only when drawn) and real-world repeat. */
export interface FinishTexture {
  url: string;
  size: readonly [number, number];
}

// URLs only: Vite content-hashes the files; nothing is fetched until a view uses one.
const TEXTURE_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../assets/textures/*.jpg', {
      query: '?url',
      import: 'default',
      eager: true,
    }),
  ).map(([path, url]) => [path.split('/').pop()!, url]),
);

export function finishTexture(f: Finish | undefined): FinishTexture | undefined {
  const url = f?.own ? f.own.url : f?.texture ? TEXTURE_URLS[f.texture] : undefined;
  return url && f?.size ? { url, size: f.size } : undefined;
}

/** An uploaded texture (D43) as a finish. */
export const ownFinish = (t: OwnTexture): Finish => ({
  key: t.key,
  label: t.label,
  color: t.color,
  size: t.size,
  own: { url: t.url ?? null },
});

/** Uploaded textures of one kind, as finishes, in upload order. */
export const ownFinishes = (
  own: readonly OwnTexture[] | undefined,
  kind: OwnTexture['kind'],
): Finish[] => (own ?? []).filter((t) => t.kind === kind).map(ownFinish);

const ownOf = (own: readonly OwnTexture[] | undefined, key: string, kind: OwnTexture['kind']) => {
  const t = own?.find((x) => x.key === key && x.kind === kind);
  return t && ownFinish(t);
};

/** Tests only: the texture files shipped. */
export const shippedTextures = (): readonly string[] => Object.keys(TEXTURE_URLS);

export interface Paint {
  label: string;
  color: string;
}

const data = finishesJson as unknown as {
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

/**
 * The floor finish of a room, or undefined (none chosen, or a key that is neither built in nor
 * one of `own`, the uploaded textures).
 */
export const floorFinish = (
  key: string | null | undefined,
  own?: readonly OwnTexture[],
): Finish | undefined => (key ? (floors.get(key) ?? ownOf(own, key, 'floor')) : undefined);

const HEX = /^#[0-9a-f]{6}$/i;

export type WallFinish = { kind: 'paint'; color: string } | { kind: 'wallpaper'; finish: Finish };

/** A room's `walls` value read: a paint colour or a known wallpaper; undefined otherwise. */
export function wallFinish(
  value: string | null | undefined,
  own?: readonly OwnTexture[],
): WallFinish | undefined {
  if (!value) return undefined;
  if (HEX.test(value)) return { kind: 'paint', color: value };
  const w = wallpapers.get(value) ?? ownOf(own, value, 'wallpaper');
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
