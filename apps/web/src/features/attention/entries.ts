/**
 * The attention list (milestone 8, D38): what needs doing, from each item's status (data
 * contract §4). Pure, so it is tested without React. One entry per thing to do, so an item
 * whose check is due and whose warranty ends shows twice, each at its own date.
 */
import type { Item, Snapshot } from '../../api/types';
import { currentStatus } from '../../components/status';
import type { Status } from '../../domain/status';

export type AttentionKind = 'check_overdue' | 'check_due' | 'warranty_ending';

export interface AttentionEntry {
  /** `<item id>:check` or `<item id>:warranty`. */
  key: string;
  item: Item;
  kind: AttentionKind;
  /** The date it is due (ISO). */
  date: string;
  /** Days from today; negative when overdue. */
  days: number;
  /** The check date comes from `check_every`, not an explicit `next_check`. */
  derived: boolean;
}

export interface Attention {
  /** Checks past their date, longest overdue first. */
  overdue: AttentionEntry[];
  /** Checks due within 30 days and warranties ending within 60, soonest first. */
  upcoming: AttentionEntry[];
}

const byDate = (a: AttentionEntry, b: AttentionEntry) =>
  a.date.localeCompare(b.date) ||
  a.item.name.localeCompare(b.item.name, undefined, { sensitivity: 'base' }) ||
  a.key.localeCompare(b.key);

export function attentionEntries(
  items: readonly Item[],
  statusOf: (item: Item) => Status,
): Attention {
  const overdue: AttentionEntry[] = [];
  const upcoming: AttentionEntry[] = [];
  for (const item of items) {
    const { check, warranty } = statusOf(item);
    if (check && check.state !== 'scheduled') {
      const entry: AttentionEntry = {
        key: `${item.id}:check`,
        item,
        kind: check.state === 'overdue' ? 'check_overdue' : 'check_due',
        date: check.date,
        days: check.days,
        derived: check.derived,
      };
      (check.state === 'overdue' ? overdue : upcoming).push(entry);
    }
    if (warranty?.state === 'ending')
      upcoming.push({
        key: `${item.id}:warranty`,
        item,
        kind: 'warranty_ending',
        date: warranty.date,
        days: warranty.days,
        derived: false,
      });
  }
  return { overdue: overdue.sort(byDate), upcoming: upcoming.sort(byDate) };
}

const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

/** What the entry says, never colour alone (DESIGN 15.12). */
export function entryText(e: AttentionEntry): string {
  switch (e.kind) {
    case 'check_overdue':
      return `Check overdue by ${days(-e.days)}`;
    case 'check_due':
      return e.days === 0 ? 'Check due today' : `Check due in ${days(e.days)}`;
    case 'warranty_ending':
      return e.days === 0 ? 'Warranty ends today' : `Warranty ends in ${days(e.days)}`;
  }
}

/** How many items need attention today (the count on the view switch). */
export const attentionCount = (snapshot: Snapshot, now: Date = new Date()): number =>
  snapshot.items.filter((i) => currentStatus(i, snapshot, now).level !== null).length;
