/** Status wording. Status is never shown by colour alone (DESIGN 15.12): every chip has text. */
import type { Item, Snapshot } from '../api/types';
import { formatDate, todayIn } from '../domain/dates';
import { lastServiceDate } from '../domain/notes';
import { type Level, type Status, computeStatus } from '../domain/status';

export type Tone = 'bad' | 'warn' | 'ok' | 'muted';

export interface Chip {
  tone: Tone;
  /** Short glyph shown before the text; decorative. */
  glyph: string;
  text: string;
}

const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

export const LEVEL_TEXT: Record<Level, string> = {
  overdue: 'Check overdue',
  due_soon: 'Check due soon',
  warranty_ending: 'Warranty ending',
};

export const levelTone = (level: Level): Tone => (level === 'overdue' ? 'bad' : 'warn');

export function statusChips(status: Status): Chip[] {
  const out: Chip[] = [];
  const { check, warranty } = status;
  if (check) {
    if (check.state === 'overdue')
      out.push({ tone: 'bad', glyph: '!', text: `Check overdue by ${days(-check.days)}` });
    else if (check.state === 'due_soon')
      out.push({
        tone: 'warn',
        glyph: '◆',
        text: check.days === 0 ? 'Check due today' : `Check due in ${days(check.days)}`,
      });
    else out.push({ tone: 'muted', glyph: '○', text: `Next check ${formatDate(check.date)}` });
  }
  if (warranty) {
    if (warranty.state === 'ending')
      out.push({
        tone: 'warn',
        glyph: '■',
        text:
          warranty.days === 0 ? 'Warranty ends today' : `Warranty ends in ${days(warranty.days)}`,
      });
    else if (warranty.state === 'active')
      out.push({
        tone: 'ok',
        glyph: '✓',
        text: `Under warranty until ${formatDate(warranty.date)}`,
      });
    else out.push({ tone: 'muted', glyph: '–', text: 'Out of warranty' });
  }
  return out;
}

/**
 * The item's status for today in the household time zone. The snapshot's status is used as is
 * while its `today` is still today; a tab left open past midnight recomputes with the same rules.
 */
export function currentStatus(item: Item, snapshot: Snapshot, now: Date = new Date()): Status {
  let today: string;
  try {
    today = todayIn(snapshot.timezone, now);
  } catch {
    return item.status;
  }
  if (today === snapshot.today) return item.status;
  return computeStatus(today, { ...item.fields, last_service: lastServiceDate(item.body) });
}
