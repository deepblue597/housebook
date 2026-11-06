// Friendly names for the generated OpenAPI types (schema.gen.ts, `pnpm gen:api`).
import type { components } from './schema.gen';

type Schemas = components['schemas'];

export type Snapshot = Schemas['SnapshotOut'];
export type Item = Schemas['ItemDetailOut'];
export type House = Schemas['House'];
export type Room = Schemas['Room'];
export type Floor = Schemas['Floor'];
export type Opening = Schemas['Opening'];
export type Placement = Schemas['Placement'];
export type Attachment = Schemas['AttachmentOut'];
export type ItemStatus = Schemas['Status'];
export type Me = Schemas['MeOut'];
export type Problem = Schemas['Problem'];
export type HouseProblemReason = Schemas['HouseProblemReason'];
export type ProblemKind = Schemas['ProblemKind'];
export type Severity = Schemas['Severity'];

// SSE payloads of GET /api/events (data contract §9; not in the OpenAPI spec).
export interface ResyncEvent {
  houseEtag: string | null;
  houseReadOnly: boolean;
  itemsVersion: string;
  problemCount: number;
}
export interface HouseChangedEvent {
  etag: string | null;
  readOnly: boolean;
}
export interface ItemChangedEvent {
  id: string;
  etag: string;
  path: string;
  stale: boolean;
  attachmentsEtag: string;
}
export interface ItemDeletedEvent {
  id: string;
}
export interface ProblemsChangedEvent {
  count: number;
}
