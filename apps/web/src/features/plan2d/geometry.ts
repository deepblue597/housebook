/** Plan drawing units: tiles × S, with margins for the title block. */
import type { Bounds } from './usePanZoom';

export const S = 40; // plan units per tile
export const MARGIN = 28;
export const FOOTER = 70;

export function planBounds(grid: { width: number; depth: number }): Bounds {
  return {
    x: -MARGIN,
    y: -MARGIN,
    w: grid.width * S + 2 * MARGIN,
    h: grid.depth * S + MARGIN + FOOTER,
  };
}
