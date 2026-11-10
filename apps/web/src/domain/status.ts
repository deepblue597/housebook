/**
 * Item status: computed, never stored (DESIGN §4, data contract §4). Mirrors
 * apps/api/.../domain/status.py; golden cases in contract/fixtures/status_cases.json.
 */
import { addDays, addMonths, daysBetween } from './dates';

export const DUE_SOON_DAYS = 30;
export const WARRANTY_ENDING_DAYS = 60;

export type Level = 'overdue' | 'due_soon' | 'warranty_ending';

export interface CheckStatus {
  state: 'overdue' | 'due_soon' | 'scheduled';
  date: string;
  days: number; // negative when overdue
  derived: boolean; // computed from check_every rather than next_check
}

export interface WarrantyStatus {
  state: 'expired' | 'ending' | 'active';
  date: string;
  days: number;
}

export interface Status {
  level: Level | null;
  check: CheckStatus | null;
  warranty: WarrantyStatus | null;
}

export interface StatusInput {
  next_check?: string | null;
  warranty_until?: string | null;
  check_every?: string | null;
  last_service?: string | null;
  purchased?: string | null;
}

export interface Interval {
  count: number;
  unit: 'd' | 'w' | 'm' | 'y';
}

const INTERVAL = /^\s*(\d{1,4})\s*([dwmy])\s*$/iu;

/** `10d`, `2w`, `6m`, `1y` (unit case-insensitive, n >= 1); null if invalid. */
export function parseInterval(value: string): Interval | null {
  const m = INTERVAL.exec(value);
  if (!m) return null;
  const count = Number(m[1]);
  return count >= 1 ? { count, unit: m[2]!.toLowerCase() as Interval['unit'] } : null;
}

export function addInterval(iso: string, { count, unit }: Interval): string {
  switch (unit) {
    case 'd':
      return addDays(iso, count);
    case 'w':
      return addDays(iso, count * 7);
    case 'm':
      return addMonths(iso, count);
    case 'y':
      return addMonths(iso, count * 12);
  }
}

/**
 * Explicit `next_check` wins. Otherwise, with `check_every`, the next check is due one interval
 * after the last maintenance-log entry, or after `purchased` if there is none.
 */
export function effectiveNextCheck(input: StatusInput): { date: string; derived: boolean } | null {
  if (input.next_check) return { date: input.next_check, derived: false };
  const interval = input.check_every ? parseInterval(input.check_every) : null;
  const base = input.last_service || input.purchased;
  return interval && base ? { date: addInterval(base, interval), derived: true } : null;
}

export function computeStatus(today: string, input: StatusInput): Status {
  let check: CheckStatus | null = null;
  let warranty: WarrantyStatus | null = null;
  let level: Level | null = null;

  const due = effectiveNextCheck(input);
  if (due) {
    const days = daysBetween(today, due.date);
    const state = days < 0 ? 'overdue' : days <= DUE_SOON_DAYS ? 'due_soon' : 'scheduled';
    check = { state, date: due.date, days, derived: due.derived };
    if (state !== 'scheduled') level = state;
  }

  if (input.warranty_until) {
    const days = daysBetween(today, input.warranty_until);
    const state = days < 0 ? 'expired' : days <= WARRANTY_ENDING_DAYS ? 'ending' : 'active';
    warranty = { state, date: input.warranty_until, days };
    if (state === 'ending' && level === null) level = 'warranty_ending';
  }

  return { level, check, warranty };
}

/**
 * After a maintenance-log entry on `entryDate`: the `next_check` to suggest (D39), or null.
 * Only for items with a valid `check_every` and an explicit `next_check` (without one, the next
 * check already follows the log, see effectiveNextCheck). The suggestion is the entry date plus
 * the interval, and only when it is later than the current next check, so logging an old
 * service never pulls the date back.
 */
export function suggestNextCheck(
  input: Pick<StatusInput, 'next_check' | 'check_every'>,
  entryDate: string,
): string | null {
  const interval = input.check_every ? parseInterval(input.check_every) : null;
  if (!interval || !input.next_check) return null;
  const next = addInterval(entryDate, interval);
  return next > input.next_check ? next : null;
}

const UNIT_WORD = { d: 'day', w: 'week', m: 'month', y: 'year' } as const;

/** `6m` → "6 months", `1y` → "year" (as in "every year"); the raw text if it doesn't parse. */
export function intervalText(value: string): string {
  const i = parseInterval(value);
  if (!i) return value;
  const word = UNIT_WORD[i.unit];
  return i.count === 1 ? word : `${i.count} ${word}s`;
}
