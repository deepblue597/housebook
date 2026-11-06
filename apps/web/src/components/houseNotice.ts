/**
 * Why the layout is read-only (data contract §2.3), in words. The cause comes from the API's
 * machine-readable `detail.reason` on `house_invalid` / `house_newer_version` problems (data
 * contract §7.1), never from the message text, which is for people and may change (M2-07).
 */
import type { HouseProblemReason, Problem } from '../api/types';

export type ReadOnlyReason = HouseProblemReason | 'unknown';

export interface ReadOnlyNotice {
  reason: ReadOnlyReason;
  text: string;
  /** The backend's own message, for the curious owner. */
  detail: string | null;
}

const KNOWN: ReadonlySet<string> = new Set<HouseProblemReason>([
  'unreadable',
  'too_large',
  'not_json',
  'bad_version',
  'newer_version',
  'invalid',
]);

/** The problem's reason; a missing or unknown one (a newer backend) counts as `invalid`. */
function reasonOf(p: Problem): HouseProblemReason {
  if (p.kind === 'house_newer_version') return 'newer_version';
  const r = p.detail?.reason;
  return r && KNOWN.has(r) ? r : 'invalid';
}

const TEXT: Record<Exclude<HouseProblemReason, 'newer_version'>, string> = {
  bad_version:
    'house.json has a missing or unsupported schemaVersion, so the layout is read-only until the file is fixed.',
  unreadable:
    'house.json can’t be read (check the file’s permissions), so the layout is read-only until it can be read again.',
  too_large:
    'house.json is larger than 16 MiB, so the layout is read-only until the file is made smaller.',
  not_json:
    'house.json is not valid JSON (a syntax error, such as a missing comma or quote), so the layout is read-only until the file is fixed.',
  invalid: 'house.json is not valid, so the layout is read-only until the file is fixed.',
};

export function readOnlyNotice(
  problems: readonly Problem[] | null,
  schemaVersion: number | null,
): ReadOnlyNotice {
  const house = (problems ?? []).filter(
    (p) => p.kind === 'house_invalid' || p.kind === 'house_newer_version',
  );
  const newer = house.find((p) => reasonOf(p) === 'newer_version');
  if (newer) {
    // Prefer the house_invalid companion ("can't be displayed by this image…") as the detail.
    const invalid = house.find((p) => p.kind === 'house_invalid');
    return {
      reason: 'newer_version',
      text: `This house layout was written by a newer Housebook version (schema ${schemaVersion ?? '?'}). It is shown read-only.`,
      detail: invalid?.message ?? null,
    };
  }
  const invalid = house[0];
  if (invalid) {
    const reason = reasonOf(invalid) as Exclude<HouseProblemReason, 'newer_version'>;
    return { reason, text: TEXT[reason], detail: invalid.message };
  }
  return { reason: 'unknown', text: 'The house layout is read-only.', detail: null };
}
