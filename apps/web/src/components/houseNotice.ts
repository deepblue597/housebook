/**
 * Why the layout is read-only (data contract §2.3), in words, from the problem kinds the API
 * reports. Each case names its real cause: a newer schema, a bad or missing schemaVersion, or
 * an invalid file.
 */
import type { Problem } from '../api/types';

export type ReadOnlyReason = 'newer_version' | 'bad_version' | 'invalid' | 'unknown';

export interface ReadOnlyNotice {
  reason: ReadOnlyReason;
  text: string;
  /** The backend's own message, for the curious owner. */
  detail: string | null;
}

export function readOnlyNotice(
  problems: readonly Problem[] | null,
  schemaVersion: number | null,
): ReadOnlyNotice {
  const newer = problems?.find((p) => p.kind === 'house_newer_version');
  const invalid = problems?.find((p) => p.kind === 'house_invalid');
  if (newer) {
    return {
      reason: 'newer_version',
      text: `This house layout was written by a newer Housebook version (schema ${schemaVersion ?? '?'}). It is shown read-only.`,
      detail: invalid?.message ?? null,
    };
  }
  if (invalid && /schemaVersion/u.test(invalid.message)) {
    return {
      reason: 'bad_version',
      text: 'house.json has a missing or unsupported schemaVersion, so the layout is read-only until the file is fixed.',
      detail: invalid.message,
    };
  }
  if (invalid) {
    return {
      reason: 'invalid',
      text: 'house.json is not valid, so the layout is read-only until the file is fixed.',
      detail: invalid.message,
    };
  }
  return { reason: 'unknown', text: 'The house layout is read-only.', detail: null };
}
