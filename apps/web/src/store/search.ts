/** Client-side search over the snapshot (D9), shared by the search box, plan and list. */
import { useMemo } from 'react';
import { search } from '../domain/search';
import { useData } from './data';
import { useUi } from './ui';

export interface SearchResults {
  active: boolean;
  /** Matching item ids, best first. */
  ids: string[];
  matches: ReadonlySet<string>;
  /** Floor id -> number of matches on it. */
  perFloor: ReadonlyMap<string, number>;
}

export function useSearchResults(): SearchResults {
  const model = useData((s) => s.model);
  const query = useUi((s) => s.query);
  return useMemo(() => {
    const active = query.trim() !== '';
    const ids = active && model ? search(model.searchDocs, query) : [];
    const perFloor = new Map<string, number>();
    for (const id of ids) {
      const floorId = model?.items.get(id)?.location?.floorId;
      if (floorId) perFloor.set(floorId, (perFloor.get(floorId) ?? 0) + 1);
    }
    return { active, ids, matches: new Set(ids), perFloor };
  }, [model, query]);
}
