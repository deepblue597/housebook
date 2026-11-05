/**
 * Body conventions (data contract §3.5). Mirrors apps/api/.../domain/item.py.
 *
 * - Error codes: bold text at the very start of a list item under a "Quick help" heading.
 * - Maintenance log: list items starting with `YYYY-MM-DD` under "Maintenance log".
 */
import { isIsoDate } from './dates';

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const CODE = /^\s*[-*+]\s+\*\*(.+?)\*\*/u;
const LOG = /^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})\b/u;

/**
 * Lines under every heading whose text equals `title` (case-insensitive), up to the next
 * heading of the same or a higher level.
 */
export function sectionLines(body: string, title: string): string[] {
  const want = title.toLowerCase();
  const out: string[] = [];
  let level: number | null = null;
  for (const line of body.split('\n')) {
    const m = HEADING.exec(line);
    if (m) {
      const depth = m[1]!.length;
      if (level !== null && depth <= level) level = null;
      if (m[2]!.trim().toLowerCase() === want) {
        level = depth;
        continue;
      }
    }
    if (level !== null) out.push(line);
  }
  return out;
}

/** `- **E15**: water in the base` -> `E15` (a trailing `:` inside the bold is dropped). */
export function errorCodes(body: string): string[] {
  const codes: string[] = [];
  for (const line of sectionLines(body, 'Quick help')) {
    const m = CODE.exec(line);
    if (m) codes.push(m[1]!.trim().replace(/:+$/u, '').trim());
  }
  return codes;
}

/** Latest `- YYYY-MM-DD ...` entry under "Maintenance log", or null. */
export function lastServiceDate(body: string): string | null {
  let latest: string | null = null;
  for (const line of sectionLines(body, 'Maintenance log')) {
    const d = LOG.exec(line)?.[1];
    if (d && isIsoDate(d) && (latest === null || d > latest)) latest = d;
  }
  return latest;
}
