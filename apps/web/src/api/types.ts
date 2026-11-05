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
