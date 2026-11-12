/** Pages made for paper (D44, D45): `/print/<page>`, each in its own chunk, without live sync. */
export const PRINT_PAGES = ['emergency', 'stickers'] as const;
export type PrintPage = (typeof PRINT_PAGES)[number];

export function printPageOf(pathname: string): PrintPage | null {
  const m = /^\/print\/([a-z]+)\/?$/u.exec(pathname);
  return m && (PRINT_PAGES as readonly string[]).includes(m[1]!) ? (m[1] as PrintPage) : null;
}

/** `items`: preselect these (an empty list selects none); left out, every item. */
export const printPath = (page: PrintPage, items?: readonly string[]): string =>
  `/print/${page}${items ? `?items=${items.map(encodeURIComponent).join(',')}` : ''}`;
