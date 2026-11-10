// Line icons per item type, on a 24×24 grid (ported from the 2D prototype).
// Stroke colour comes from CSS (`.ico`), so they follow the theme.
import type { ReactElement } from 'react';
import { itemType } from './catalog';

const ICONS: Record<string, ReactElement> = {
  fridge: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M6 10h12M9 6v2M9 13v3" />
    </>
  ),
  oven: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16" />
      <rect x="7.5" y="12" width="9" height="5" rx="1" />
      <circle cx="8" cy="6.5" r=".6" />
      <circle cx="12" cy="6.5" r=".6" />
      <circle cx="16" cy="6.5" r=".6" />
    </>
  ),
  dishwasher: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 7.5h16M8 5.3h3M15.5 5.3h.5M9 12l3 4 3-4" />
    </>
  ),
  washer: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 7h16" />
      <circle cx="12" cy="14" r="4.3" />
      <circle cx="7.5" cy="5" r=".6" />
    </>
  ),
  dryer: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 7h16" />
      <circle cx="12" cy="14" r="4.3" />
      <path d="M10 14.5c.7-1 1.3 1 2 0s1.3 1 2 0" />
    </>
  ),
  microwave: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="1.5" />
      <rect x="5.5" y="8.5" width="9.5" height="7" rx="1" />
      <path d="M18 9.5v.5M18 12v.5M18 14.5v.5" />
    </>
  ),
  ac: (
    <>
      <rect x="3" y="5" width="18" height="8" rx="2" />
      <path d="M6 10h12M8 16v3M12 16v4M16 16v3" />
    </>
  ),
  heater: (
    <>
      <rect x="6.5" y="3" width="11" height="15" rx="4" />
      <path d="M12 7.5c-1.6 1.7-2.2 2.8-1.2 4.3a1.4 1.4 0 0 0 2.4 0c1-1.5.4-2.6-1.2-4.3zM9.5 18v3M14.5 18v3" />
    </>
  ),
  boiler: (
    <>
      <rect x="5" y="3" width="14" height="15" rx="2" />
      <path d="M12 7c-1.8 1.9-2.4 3.1-1.3 4.8a1.5 1.5 0 0 0 2.6 0c1.1-1.7.5-2.9-1.3-4.8zM5 14.5h14M9 18v3M15 18v3" />
    </>
  ),
  radiator: (
    <>
      <rect x="4" y="5" width="4" height="13" rx="1.5" />
      <rect x="10" y="5" width="4" height="13" rx="1.5" />
      <rect x="16" y="5" width="4" height="13" rx="1.5" />
      <path d="M3 15h18" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  router: (
    <>
      <rect x="3" y="13" width="18" height="6" rx="1.5" />
      <path d="M7 13 5.5 7M17 13l1.5-6" />
      <circle cx="7" cy="16" r=".6" />
      <circle cx="10" cy="16" r=".6" />
    </>
  ),
  computer: (
    <>
      <rect x="4" y="3" width="16" height="11" rx="1.5" />
      <path d="M12 14v3M9 17h6" />
      <rect x="5" y="19" width="11" height="2" rx=".5" />
      <path d="M18.5 19.5v1" />
    </>
  ),
  laptop: (
    <>
      <rect x="5" y="5" width="14" height="10" rx="1.5" />
      <path d="M2.5 18h19l-1.5 2h-16z" />
    </>
  ),
  valve: <path d="M3 14h5M16 14h5M8 10v8l8-8v8zM12 14V7M9 7h6" />,
  gas_valve: (
    <>
      <path d="M3 16h5M16 16h5M8 12v8l8-8v8zM12 16V9M9 9h6" />
      <path d="M12 2.5c-1 1-1.3 1.7-.7 2.6a.8.8 0 0 0 1.4 0c.6-.9.3-1.6-.7-2.6z" />
    </>
  ),
  fuse: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M13 7l-3 5h4l-3 5" />
    </>
  ),
  smoke: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v2M12 18v2M4 12h2M18 12h2" />
    </>
  ),
  other: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />
  ),
};

export const iconFor = (type: string | null | undefined): ReactElement =>
  ICONS[itemType(type)?.key ?? 'other'] ?? ICONS.other!;

/** Icon paths only, for embedding inside the plan's SVG. */
export const typeIconPaths = iconFor;
