/**
 * Colour contrast (WCAG 2.x) for room labels drawn over translucent room tiles (DESIGN 15.12:
 * label colour picked for 4.5:1 against the room colour).
 */

export type Rgb = readonly [number, number, number];

const HEX = /^#?([0-9a-f]{6})$/iu;

export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` painted with `alpha` over `bottom`. */
export const blend = (top: Rgb, bottom: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(top[i]! * alpha + bottom[i]! * (1 - alpha))) as unknown as Rgb;

/** The candidate with the best contrast against `background` (first wins ties). */
export function bestTextColor<T extends { rgb: Rgb }>(
  background: Rgb,
  candidates: readonly T[],
): T {
  return candidates.reduce((best, c) =>
    contrastRatio(c.rgb, background) > contrastRatio(best.rgb, background) ? c : best,
  );
}
