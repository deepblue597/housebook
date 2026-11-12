/**
 * A QR code as one SVG path (D45): crisp at any print size, no canvas, no raster. Error
 * correction M (15 % of the code can be scuffed or covered) and the 4-module quiet zone the
 * standard asks for are included in the size.
 */
import qrcode from 'qrcode-generator';

export const QUIET = 4;

export interface QrPath {
  /** Modules per side, quiet zone included: the SVG viewBox is `0 0 size size`. */
  size: number;
  /** Dark modules, merged into horizontal runs. */
  d: string;
}

export function qrPath(text: string): QrPath {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && qr.isDark(r, c)) c++;
      d += `M${start + QUIET} ${r + QUIET}h${c - start}v1h${start - c}z`;
    }
  }
  return { size: n + 2 * QUIET, d };
}

/** The sticker's link: the item's stable deep link (D16) on this app's address. */
export const stickerUrl = (origin: string, id: string): string =>
  `${origin.replace(/\/+$/u, '')}/i/${encodeURIComponent(id)}`;
