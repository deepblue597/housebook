/** The integrity report (`GET /api/problems`), fetched only when the UI needs to explain something. */
import { useEffect, useState } from 'react';
import { getJson } from '../api/client';
import type { Problem } from '../api/types';

/** Problems about house.json, refetched whenever `key` (e.g. the house ETag) changes. */
export function useHouseProblems(enabled: boolean, key: string | null): Problem[] | null {
  const [problems, setProblems] = useState<{ key: string | null; list: Problem[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    getJson('/api/problems', ctrl.signal).then(
      (r) => setProblems({ key, list: r.problems.filter((p) => p.path === 'house.json') }),
      () => setProblems({ key, list: [] }),
    );
    return () => ctrl.abort();
  }, [enabled, key]);
  return enabled && problems?.key === key ? problems.list : null;
}
