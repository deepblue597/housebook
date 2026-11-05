/**
 * URL safety (DESIGN 15.13): only http, https, mailto, tel and obsidian links become clickable,
 * in note bodies and in the `manual` / `support` fields. `javascript:` never does.
 */

export const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'mailto',
  'tel',
  'obsidian',
]);

// Browsers drop ASCII whitespace and control characters anywhere in a URL's scheme
// ("java\tscript:"), so strip them before looking for one.
// eslint-disable-next-line no-control-regex
const IGNORED = /[\u0000- \u007f]/gu;
const SCHEME = /^([a-z][a-z0-9+.-]*):/iu;

/** The URL's scheme in lower case, or null for a relative URL. */
export function schemeOf(url: string): string | null {
  const m = SCHEME.exec(url.replace(IGNORED, ''));
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * `//host/path` (browsers also accept backslashes) takes the page's scheme, so it leaves the
 * site just like `https://host/path` and is treated as an absolute web URL.
 */
export const isProtocolRelative = (url: string): boolean =>
  /^[/\\]{2}/u.test(url.replace(IGNORED, ''));

/** Absolute: a scheme, or protocol-relative. */
const isAbsolute = (url: string) => schemeOf(url) !== null || isProtocolRelative(url);

/** The URL if it may be rendered as a link (allowed scheme, or relative), else null. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const scheme = schemeOf(trimmed);
  // Protocol-relative URLs inherit http(s) from the page, which the allowlist permits.
  return scheme === null || ALLOWED_SCHEMES.has(scheme) ? trimmed : null;
}

/** Like `safeHref`, but the URL must be absolute (frontmatter `manual`, `support`). */
export function safeExternalHref(url: string | null | undefined): string | null {
  const href = safeHref(url);
  return href && isAbsolute(href) ? href : null;
}

/** Links that leave the app: opened in a new tab with `rel="noopener noreferrer"`. */
export const isWebUrl = (href: string): boolean => {
  const s = schemeOf(href);
  return s === 'http' || s === 'https' || (s === null && isProtocolRelative(href));
};
