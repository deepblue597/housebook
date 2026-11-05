// Item types from the shared contract (contract/catalog.json). Also served by /api/catalog;
// bundling it means the plan can draw before that request and works offline.
import catalogJson from '@contract/catalog.json';

export interface ItemType {
  key: string;
  label: string;
  defaultName: string;
  /** `[w, d]` in tiles at rotation 0 (data contract §2.2). */
  footprint: readonly [number, number];
  mount: Mount;
  critical: boolean;
}

export type Mount = 'floor' | 'wall' | 'ceiling';

const types = catalogJson.types as unknown as readonly (ItemType & { aliases: string[] })[];
const byKey = new Map<string, ItemType>();
for (const t of types) {
  byKey.set(t.key, t);
  for (const a of t.aliases) byKey.set(a.toLowerCase(), t);
}

/** Catalogue entry for a type key or alias (case-insensitive); undefined if unknown. */
export const itemType = (key: string | null | undefined): ItemType | undefined =>
  key ? byKey.get(key.toLowerCase()) : undefined;

/** Label for any item type; unknown types show their raw key (they render as "Other"). */
export const typeLabel = (key: string | null | undefined): string =>
  itemType(key)?.label ?? (key || 'Other');

/** Footprint and mount for any type; unknown and missing types use "other" (a 1×1 floor box). */
export function placementSpec(key: string | null | undefined): {
  footprint: readonly [number, number];
  mount: Mount;
} {
  const t = itemType(key) ?? byKey.get('other');
  return { footprint: t?.footprint ?? [1, 1], mount: t?.mount ?? 'floor' };
}
