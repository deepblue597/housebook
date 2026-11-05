/** Scene colours per theme, derived from the same tokens as the 2D plan (app/theme.ts). */
import { PALETTE } from '../../app/theme';
import { blend, parseHex, toHex } from '../../domain/color';

export interface ScenePalette {
  ink: string;
  paper: string;
  wall: string;
  grid: string;
  glass: string;
  accent: string;
  /** A room's floor colour: its colour softened towards the paper, like the 2D tiles. */
  floor: (roomColor: string) => string;
}

const ACCENT = { light: '#2f5da8', dark: '#88aaeb' } as const;
const GRID = { light: '#d3dcda', dark: '#24323a' } as const;

export function scenePalette(theme: 'light' | 'dark'): ScenePalette {
  const { ink, paper } = PALETTE[theme];
  const inkRgb = parseHex(ink)!;
  const paperRgb = parseHex(paper)!;
  const share = theme === 'dark' ? 0.55 : 0.6;
  return {
    ink,
    paper,
    wall: toHex(blend(inkRgb, paperRgb, theme === 'dark' ? 0.42 : 0.22)),
    grid: GRID[theme],
    glass: theme === 'dark' ? '#6fa7c9' : '#8ec5e6',
    accent: ACCENT[theme],
    floor: (color) => {
      const rgb = parseHex(color);
      return rgb ? toHex(blend(rgb, paperRgb, share)) : paper;
    },
  };
}
