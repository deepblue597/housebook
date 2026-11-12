// UI text of the QR sticker sheet (D45).
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const STICKERS = {
  title: 'QR stickers',
  back: 'Back to the house',
  print: 'Print or save as PDF',
  printHint:
    'Stick one on each appliance: scanning it opens the item in Housebook (after signing in). Print on sticker paper, or on plain paper and tape it on; cut along the dashed lines.',
  loading: 'Loading the house…',
  loadFailed: 'Couldn’t load the house.',
  retry: 'Try again',
  choose: 'Which items',
  all: 'All',
  none: 'None',
  emergency: 'Emergency items',
  size: 'Size',
  small: 'Small (3 cm codes, 4 across)',
  large: 'Large (5 cm codes, 3 across)',
  count: (n: number) => `${plural(n, 'sticker', 'stickers')} selected`,
  nothing: 'Choose at least one item to print.',
  noItems: 'There are no items yet.',
  unplaced: 'Not on the plan',
  looseRoom: 'Not in a room',
  where: (room: string | null, floor: string | null) =>
    [room, floor].filter(Boolean).join(' · ') || 'Not on the plan',
  qrLabel: (name: string) => `QR code for ${name}`,
  // links elsewhere in the app
  open: 'QR stickers',
  openOne: 'QR sticker',
};
