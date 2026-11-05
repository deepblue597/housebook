/**
 * Calendar dates as `YYYY-MM-DD` strings (what the API sends). Arithmetic goes through UTC day
 * numbers, so local time zones and DST never shift a date.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MS = 86_400_000;

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

function parse(iso: string): Ymd | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  // Reject 2026-02-30 and friends instead of rolling over.
  return t.getUTCFullYear() === ymd.y && t.getUTCMonth() === ymd.m - 1 && t.getUTCDate() === ymd.d
    ? ymd
    : null;
}

export const isIsoDate = (value: string): boolean => parse(value) !== null;

function mustParse(iso: string): Ymd {
  const p = parse(iso);
  if (!p) throw new RangeError(`not a YYYY-MM-DD date: ${iso}`);
  return p;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const format = ({ y, m, d }: Ymd) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const dayNumber = ({ y, m, d }: Ymd) => Date.UTC(y, m - 1, d) / DAY_MS;

/** `b - a` in days. */
export const daysBetween = (a: string, b: string): number =>
  dayNumber(mustParse(b)) - dayNumber(mustParse(a));

export function addDays(iso: string, days: number): string {
  const t = new Date((dayNumber(mustParse(iso)) + days) * DAY_MS);
  return format({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Add calendar months, clamping to the month end: 31 Jan + 1m = 28/29 Feb. */
export function addMonths(iso: string, months: number): string {
  const { y, m, d } = mustParse(iso);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  return format({ y: year, m: month, d: Math.min(d, daysInMonth(year, month)) });
}

/** Today's date in an IANA time zone (HOUSEBOOK_TZ), as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return format({ y: get('year'), m: get('month'), d: get('day') });
}

const displayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `2026-11-04` -> `4 Nov 2026`; anything unparseable is returned unchanged. */
export function formatDate(iso: string): string {
  const p = parse(iso);
  return p ? displayFormat.format(new Date(Date.UTC(p.y, p.m - 1, p.d))) : iso;
}
