# Housebook: Design Document

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-11-04 |
| Author | Iasonas Kakandris |
| Prototype | https://claude.ai/artifact/1stdrrk7yrciY1XHmpnKNt (2D, browser-only) |

---

## 1. Summary

Housebook is a self-hosted web app that shows a home as a top-down 3D plan. Users build the house by painting rooms onto a 1 m tile grid, then place appliances and other fixtures (fridge, boiler, fuse box, water valve…) as generic 3D models. Clicking an item opens everything useful about it: brand, model, warranty, manual, support links, quick fixes, error codes and a maintenance log.

Item information is stored as plain Markdown files with YAML frontmatter. The app works on its own, and when the data folder sits inside an Obsidian vault, the same notes are editable in Obsidian.

## 2. Goals and non-goals

### Goals
- **G1** Build a house visually: floors, rooms (tile painting), automatic walls.
- **G2** Place items as 3D models on the plan; click to see their information.
- **G3** Store per-item information: specs, dates, links, attachments (PDF manuals, receipts, photos) and free-text notes.
- **G4** Find things fast: search across names, models, notes and error codes.
- **G5** Surface what needs attention: upcoming checks/services, warranty ending.
- **G6** Work without Obsidian; integrate with Obsidian when available.
- **G7** Self-hosted as a single Docker container; data stays as human-readable files.
- **G8** Usable by the whole household, including on phones (view mode).

### Non-goals (for v1)
- Accurate architectural drawings (CAD precision, wall thickness, measurements below 1 m).
- Smart-home control (Home Assistant does that; integration may come later).
- Multi-tenant SaaS hosting.
- Real-time collaborative editing of the same note by several people.
- Automatic manual download/scraping from manufacturer sites.

## 3. Users and main use cases

| Actor | Use case |
|---|---|
| Owner (editor) | Draws the house, adds items, writes notes, uploads manuals |
| Household member (viewer) | "The washing machine shows OE, what do I do?" → opens the plan, taps the washer, reads the quick fix |
| Anyone in an emergency | "Where is the main water valve / fuse box?" → search or look at the plan |
| Owner | "What needs servicing soon?" → attention list / badges on the plan |
| Technician visit | Owner shows model and serial number, logs the repair afterwards |

## 4. Domain model

```
House
 ├─ grid: tileSize = 1 m, width × depth (tiles)
 ├─ rooms[]        Room { id, name, color }
 ├─ floors[]       Floor { id, name, level, cells: { "x,y": roomId } }
 └─ placements[]   Placement { itemId, floorId, x, y, rotation, footprint? }

Item (one Markdown note)
 ├─ id (housebook_id), type → ItemType
 ├─ name, brand, model, serial
 ├─ purchased, warranty_until, next_check
 ├─ manual, support (URLs)
 ├─ attachments[] (files next to the note)
 └─ body (Markdown: quick help, maintenance log, notes)

ItemType (catalogue, shipped with the app)
 { key, label, defaultName, model3d, footprint [w,d], mount: floor|wall|ceiling, noteTemplate }
```

Rules:
- An item's **room is derived** from the tile it stands on. It is never stored, so moving an item never leaves stale data.
- Rooms are global (shared across floors) so "Storage" can exist on several floors; area is computed per floor.
- **Walls are derived** from tiles: an edge between a room tile and a different room or empty tile is a wall. Exterior edges (room ↔ empty) render thicker/taller.
- Status is computed, never stored:
  - `next_check` past → **overdue** (red)
  - `next_check` within 30 days → **due soon** (orange)
  - `warranty_until` within 60 days → **warranty ending** (orange)
  - `warranty_until` past → "out of warranty" (neutral, no badge)

## 5. Architecture overview

Style: **modular monolith**. One container, a client-heavy SPA and a thin API over a folder of files.

```
 Browser (React SPA)                         Server (one Docker container)
┌───────────────────────────────────┐      ┌──────────────────────────────────┐
│ UI: panels, search, forms, editor │      │ FastAPI                          │
│ Views: 3D scene  |  2D plan       │ HTTP │  ├─ api/      routes, schemas     │
│        ▲ both render from store   │◄────►│  ├─ domain/   rules, templates    │
│ Store (Zustand) + Commands        │ SSE  │  ├─ ports/    interfaces          │
│ Domain (pure TS)                  │      │  ├─ adapters/ files, index        │
│ Catalog (item types, 3D models)   │      │  └─ watcher/  file changes → SSE  │
└───────────────────────────────────┘      └───────────────┬──────────────────┘
                                                           │ volume
                                            data folder (/data or inside a vault)
```

Principles:
1. **Files are the source of truth.** Markdown notes own item content; `house.json` owns layout.
2. **One model, many views.** 2D and 3D views are pure renderings of the same store; neither holds its own state.
3. **Pure domain core** on both sides (grid maths, walls, statuses, search) with no framework imports.
4. **Ports and adapters** on the backend so storage can change without touching the domain.

## 6. Data and storage

### 6.1 Data folder layout

```
<data root>/
  house.json                  layout
  House/                      notes (configurable folder name)
    Kitchen/
      Dishwasher.md
      Dishwasher/             attachments for this item
        manual.pdf
        receipt.jpg
  .housebook/
    index.db                  SQLite cache (rebuildable, never the source of truth)
    templates/                optional user overrides of note templates
```

The data root is configured with `HOUSEBOOK_DATA_DIR`:
- **Standalone (default):** `/data` in a Docker volume. The user never sees the files unless they want to.
- **Obsidian mode:** a folder inside the vault, e.g. `/vault/Housebook` (notes then live in `/vault/Housebook/House/`), plus `HOUSEBOOK_OBSIDIAN_VAULT=homepage` to enable "Open in Obsidian" links.

### 6.2 `house.json`

```json
{
  "schemaVersion": 1,
  "grid": { "tileSize": 1.0, "width": 16, "depth": 10 },
  "rooms": [
    { "id": "rm_kit", "name": "Kitchen", "color": "#E3A94B" }
  ],
  "floors": [
    { "id": "fl_0", "name": "Apartment", "level": 0,
      "cells": { "7,1": "rm_kit", "8,1": "rm_kit" } }
  ],
  "placements": [
    { "itemId": "it_7f3k2a", "floorId": "fl_0", "x": 10, "y": 2, "rotation": 90 }
  ]
}
```

### 6.3 Item note format

```markdown
---
housebook_id: it_7f3k2a
type: dishwasher
name: Dishwasher
brand: Bosch
model: SMS4HVI33E
serial: FD 0412 00123
purchased: 2024-05-10
warranty_until: 2027-05-10
next_check: 2027-03-01
manual: https://...
support: https://www.bosch-home.gr/
tags: [housebook]
---

## Quick help
- **E15**: water in the base. Unplug, tilt back, dry, check hoses

## Maintenance log
- 2026-09-15 Technician replaced the drain pump (85 €)

## Notes
Uses 3-in-1 tabs. Salt every 2 months.
```

### 6.4 Identity
- Every item has a stable `housebook_id` in its frontmatter. `house.json` references items only by id.
- On startup the backend scans the notes folder and builds an `id → path` index. Renaming or moving a note (in Obsidian or a file manager) does not break the link between layout and note. It does break the attachments folder, which is matched by name (see 15.3).
- Notes without a `housebook_id` but with `tags: [housebook]` are adopted: an id is written into them.

### 6.5 Index (SQLite cache)
- Tables: `items(id, path, mtime, hash, type, name, brand, model, next_check, warranty_until, …)` and an FTS5 table over name, brand, model and body.
- Built at startup, updated by the file watcher. Safe to delete at any time.
- Serves search and the "needs attention" list.

### 6.6 Concurrency
- Each item response carries an `ETag` (content hash).
- Writes send `If-Match`. If the file changed meanwhile (e.g. edited in Obsidian), the server returns `412` and the UI offers to reload or overwrite.
- `house.json` uses the same mechanism.
- Writes are atomic: write to a dot-prefixed temp file in the same directory, fsync, then rename (a rename across filesystems is not atomic and fails on Docker volumes).

## 7. Frontend

### 7.1 Stack
- React + TypeScript + Vite
- three.js via **react-three-fiber**, with **drei** helpers (camera controls, GLTF loading, outlines, HTML labels)
- Zustand for state
- Markdown editor: Milkdown or TipTap (Markdown in, Markdown out)
- API types generated from FastAPI's OpenAPI spec with `openapi-typescript`

### 7.2 Layers

```
src/
  domain/      pure TS: grid, walls, areas, status rules, search matching
  store/       Zustand: house, items cache, UI state (mode, tool, selection, floor)
  commands/    PaintTiles, EraseTiles, PlaceItem, MoveItem, RotateItem, RenameRoom… (apply/undo)
  catalog/     item types → 3D model, footprint, mount, template
  features/
    scene3d/   R3F scene: floors, walls, items, picking, camera
    plan2d/    SVG plan (fallback and phones)
    editor/    tools (paint, erase, place, move) as small state machines
    details/   item panel, room panel, Markdown editor, attachments
    search/    search box, results, highlight
    attention/ due-soon list
  api/         generated client + fetch wrappers, SSE subscription
```

Rules: `domain` imports nothing; `features` never import each other's internals; all mutations go through `commands`.

### 7.3 Editing
- **Command pattern**: each edit is an object with `apply(state)` and `undo(state)`. Gives undo/redo and a clean place to sync to the server.
- **Tools** (paint, erase, place, move) each implement `onPointerDown/Move/Up(cell)`. Both 2D and 3D views translate pointer events to a grid cell and forward them to the active tool.
- Layout changes are saved to the server debounced (≈1 s after the last edit).

### 7.4 3D scene
- **Camera:** orthographic, ~45° tilt. Pan, zoom, rotate in 90° steps only.
- **Floors:** one merged mesh per room per floor, tinted with the room colour.
- **Walls:** boxes generated from wall edges; low cut-away height (~0.3 m) by default so no tile is hidden at the 45° tilt; "walls up" toggle for full height (2.5 m), where walls facing the camera fade (D18).
- **Items:** GLB models from the catalogue, placed at tile centre, rotated in 90° steps. `mount` decides height: floor (0), wall (~1.8 m, snapped to the nearest wall edge), ceiling.
- **Picking:** raycast against items first, then the floor plane → grid cell.
- **Feedback:** hover outline, selection ring, status badge (HTML overlay) above items.
- **Floors (levels):** one level visible at a time; others hidden.

### 7.5 3D assets
- Base set: **Kenney Furniture Kit** (CC0), plus Quaternius packs (CC0) for gaps. Keep one visual style.
- Missing types fall back to a labelled coloured box with the catalogue footprint.
- Pipeline: Kenney OBJ → `apps/web/scripts/obj-to-glb.mjs` → `apps/web/src/assets/models/*.glb`, imported with `?url` so names are content-hashed. Types without a CC0 model use procedural models (`features/scene3d/models/procedural.ts`).
- Licences and sha256 recorded in `apps/web/src/assets/models/LICENSES.md`.

### 7.6 Modes
- **View mode:** read-only interaction (default for viewers, and on phones).
- **Edit mode:** tool rail, palette, room list (editors only).
- **2D/3D toggle:** both always available; 2D is the default on small screens.

## 8. Backend

### 8.1 Stack
Python 3.12, FastAPI, Pydantic, `python-frontmatter`, `watchdog`, SQLite (stdlib `sqlite3`), uvicorn.

### 8.2 Structure (ports and adapters)

```
app/
  domain/     Item, House, status rules, template rendering, path naming
  ports/      HouseRepo, NoteRepo, AttachmentStore, SearchIndex   (Protocols)
  adapters/   FsHouseRepo, MarkdownNoteRepo, FsAttachmentStore, SqliteIndex
  api/        routes, schemas, auth dependency
  watcher/    watchdog → reindex → SSE broadcast
  main.py     wiring (config → adapters → routes)
```

### 8.3 API (v1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/house` | Layout (with ETag) |
| PUT | `/api/house` | Replace layout (`If-Match`) |
| GET | `/api/items` | List/search (`?q=`, `?due=30`) from index |
| POST | `/api/items` | Create item note from template (type, name). The client then adds the placement via `PUT /api/house` (D8) |
| GET | `/api/items/{id}` | Frontmatter + body + attachments (with ETag) |
| PATCH | `/api/items/{id}` | Update fields and/or body (`If-Match`) |
| DELETE | `/api/items/{id}` | Delete note (moves to `.housebook/trash/`). The client removes the placement first via `PUT /api/house` (D8) |
| POST | `/api/items/{id}/attachments` | Upload file |
| GET | `/api/items/{id}/attachments/{name}` | Download/preview file |
| GET | `/api/events` | SSE: `item.changed`, `item.deleted`, `house.changed` |
| GET | `/api/catalog` | Item types (also bundled in the frontend) |
| GET | `/api/export` | Zip of the whole data folder |

### 8.4 Note placement and naming
- New notes go to `House/<Room>/<Name>.md`; attachments to `House/<Room>/<Name>/`.
- Moving an item to another room does **not** move its file (ids make paths irrelevant). An optional "tidy files" action can reorganise later.

## 9. Security and access
- Runs behind the user's reverse proxy with TLS.
- Authentication: OIDC (Keycloak, Authelia, Authentik) via the proxy or the app; or network-only access (Tailscale/LAN) for single-user setups.
- Roles: `editor` (all writes) and `viewer` (read-only). Enforced in the API, not just hidden in the UI.
- Uploads: size limit, allowed types (PDF, raster images; no SVG or HTML), served with `Content-Disposition` and safe content types.
- Path safety: all file paths resolved and checked to stay inside the data root.
- Markdown rendered with sanitisation (no raw HTML/scripts).

## 10. Deployment
- Single image, multi-stage Dockerfile: build web (Node) → copy static files into the Python image → FastAPI serves API and SPA.
- `compose.yaml` with one service and one volume (`/data`), or a bind mount into an Obsidian vault.
- Config by environment variables: `HOUSEBOOK_DATA_DIR`, `HOUSEBOOK_NOTES_DIR`, `HOUSEBOOK_OBSIDIAN_VAULT`, `HOUSEBOOK_AUTH_*`.
- Backups: the data folder is the backup unit (volume snapshot, restic, git, or `/api/export`).

## 11. Testing
- **Frontend unit (vitest):** domain functions (walls, areas, statuses, search), commands apply/undo.
- **Backend unit/integration (pytest):** adapters against a temporary data folder; ETag conflicts; adoption of untagged notes; path safety.
- **End-to-end (Playwright):** paint a room, place a fridge, edit its notes, reload, search for it.

## 12. Build plan

| # | Milestone | Content | Estimate |
|---|---|---|---|
| 1 | 3D viewer | Load `house.json`, floors, walls, box models, click → details | 1–2 days |
| 2 | Real models | Kenney models, catalogue with footprint/mount/rotation | 1 day |
| 3 | 3D editor | Paint/erase/place/move/rotate in 3D, undo/redo, 2D fallback | 2–3 days |
| 4 | Backend | FastAPI, Markdown repo, index, ETags, SSE, Docker | 1–2 days |
| 5 | Notes and files | Markdown editor, templates, attachments, first-run setup | 2 days |
| 6 | Polish | Attention list, doors/windows, wall fading, phone UX, auth roles | ongoing |

## 13. Open questions
1. Do items need footprints bigger than 1×1 in v1 (sofa, kitchen counter), or only later?
2. Should several items share a tile (e.g. router on a shelf above a cabinet)?
3. Reminders: in-app only, or also push/email/calendar (ICS feed)?
4. QR stickers: per-item public read-only links, or only for logged-in users?
5. How should a note deleted in Obsidian be treated: delete placement, or keep it as "missing note"?

## 14. Decisions (summary)

| # | Decision | Reason |
|---|---|---|
| D1 | Modular monolith, single container | Household scale; simplest to run and back up |
| D2 | Markdown files as source of truth, SQLite as cache | Human-readable, Obsidian-compatible, rebuildable index |
| D3 | Obsidian optional | App must work standalone; Obsidian is an integration |
| D4 | react-three-fiber over raw three.js | UI and scene in one React codebase, declarative scene |
| D5 | Orthographic top-down camera with 90° rotation | Easy picking, readable plan, phone-friendly |
| D6 | Stable ids in frontmatter | Notes can be renamed/moved without breaking links |
| D7 | Optimistic concurrency with ETags | Safe editing alongside Obsidian without locks |

---

## 15. Architecture review (Software Architect)

Reviewed 2026-11-04 against Draft v0.1. The core choices hold up for one household: files as the source of truth, derived room/walls/status, a single container, ETags. The weak spots are (a) several writers touching the same files (the app, Obsidian, sync tools), (b) the main emergency case happening exactly when the server is down, and (c) a few parts that are heavier than one household needs. This section adds to the doc; the sections above are unchanged except for the fixes in 15.1.

### 15.1 Inline corrections made

- §6.1: Obsidian-mode example changed from `/vault/House` to `/vault/Housebook`. With the default notes folder `House/` the old example gave `/vault/House/House/`.
- §6.4: The rename guarantee covers the layout↔note link only. Attachments are matched by folder name and are orphaned when a note is renamed outside the app (fix in 15.3).
- §6.6: Temp file must be dot-prefixed, in the same directory, and fsynced before the rename. A rename across filesystems is not atomic and fails with `EXDEV` on Docker volumes.
- §8.3: `POST /api/items` and `DELETE /api/items/{id}` no longer write placements. Together with the client's debounced `PUT /api/house` they made two writers of `house.json`: a guaranteed `412` on the next autosave, or a lost placement. See D8.
- §9: Upload allowlist narrowed to PDF and raster images. SVG counts as an image and runs script when opened directly.

### 15.2 Consistency between `house.json` and notes

- **Each file has one writer.** `house.json` is written only by `PUT /api/house` (and by migrations at startup). Notes are written by the item endpoints, Obsidian and sync tools. No operation has to update both files atomically.
- **Write order makes the crash state harmless.** Create: write the note, then the client adds the placement and saves. Delete: the client removes the placement and saves, then deletes the note. A crash between the two steps leaves an unplaced note, never a placement pointing to nothing.
- **Both inconsistent states are normal UI states, not errors:**
  - *Unplaced item* (note, no placement): shown in an "Unplaced" tray in edit mode, ready to drag onto the plan.
  - *Missing note* (placement, no note): ghost model with a "note missing" badge and two actions: relink to another note, or remove the placement. This answers Q5: never delete placements automatically.
- **Grace period for deletions.** Renames in Obsidian, Syncthing and most file managers arrive as delete + create. Hold `item.deleted` for ~3 s; if the same id appears at another path, send `item.changed` with the new path instead.
- **Duplicate ids** come from "duplicate note" in Obsidian and from sync conflict copies. Rule: the canonical file is the path already in the index; otherwise the one whose name doesn't match a conflict pattern; otherwise the oldest mtime. The others are reported as problems, with "assign new id" and "move to trash" actions. Never rewrite them silently.
- **Parse failures keep the last good entry.** If a note fails to parse (half-written, broken YAML), keep its previous index entry and flag it "unparseable". Dropping it would make the item look deleted and its placement look dangling.
- **Integrity report** (`GET /api/problems`, computed on every scan): parse errors, duplicate ids, conflict copies, missing notes, unknown `type`, cells pointing to deleted rooms, placements outside the grid, two placements for one item, listed attachments that don't exist. Shown as a badge in edit mode. Every fix is an explicit user action.
- **Validate `house.json` on `PUT`** (Pydantic): unique ids, at most one placement per item, cells inside the grid, cells → existing rooms. Reject with `422`. The client must not be able to save a broken layout. *Amended by D30:* problems the file on disk already has may stay; only a save that makes the layout worse is rejected.
- **On `412` for the layout, replay instead of asking.** Edits are already Command objects: fetch the fresh house, re-apply pending commands that still make sense, and show a toast for any that were dropped. Keep the reload/overwrite dialog (with a diff) for notes only.
- **Layout history.** On each `PUT`, copy the previous `house.json` to `.housebook/history/house-<timestamp>.json` and keep the last 50 (or one per 10 minutes). Without this, an accidental "erase all" plus autosave plus a reload can only be undone from a backup.
- **Deterministic serialisation** of `house.json`: sorted cell keys, 2-space indent, trailing newline. Diffs in git and restic stay readable.
- **Not needed:** a write journal, an outbox or two-phase commit across files. Write order plus visible states is enough at this scale.

### 15.3 Attachments and note identity

- **List attachments in frontmatter** as wikilinks: `attachments: ["[[Dishwasher/manual.pdf]]"]`. Obsidian updates links in properties when files move, so Obsidian keeps the links correct for us. The sibling folder stays the default location for new uploads. The app shows the union of listed files and the sibling folder's files. Resolve a link in this order: relative to the note's folder, then relative to the data root, then a unique filename match under the data root (close to Obsidian's shortest-path rule).
- The "tidy files" action (§8.4) must move the attachments folder with the note and update the links.
- Alternative considered: one folder per id (`House/_files/it_7f3k2a/`). It's robust, but it looks bad in Obsidian. Rejected.
- **Filenames:** normalise to NFC (iOS/macOS send NFD, which breaks equality for Greek accents), strip path separators and control characters, limit the length, add `-2`, `-3` suffixes on collisions.

### 15.4 Schema versioning and migrations

`house.json`:
- Migrations live in the backend as pure functions, `migrations/house/v1_to_v2.py` (dict → dict), applied in sequence when the file is read. The upgraded file is written on the next save. Copy the original to `.housebook/history/house.v<n>.<timestamp>.json` before the first rewrite.
- The frontend only ever sees the current version.
- **A file with a newer `schemaVersion` than the running image supports** (after a rollback) opens read-only with a banner and is never written. Ship this in v1: an old image can't be taught it later.
- Generate a JSON Schema from the Pydantic model and reference it with a `$schema` key, so hand edits in VS Code are validated.
- **Reserve fields now** to avoid an early v2: doors and windows are in milestone 6 but missing from the model. They sit on edges: `openings: [{ floorId, x, y, side: "n" | "w", kind: "door" | "window" }]`. Storing only `n` and `w` gives every edge one key: the south edge of `(x,y)` is the north edge of `(x,y+1)`.

Frontmatter:
- No per-note version key (noise in Obsidian, and it drifts). Changes are additive only. Unknown keys are kept on write, missing keys get defaults. If a key ever has to be renamed, use an explicit CLI, `housebook migrate-notes --dry-run`, which backs up first and prints the diff.
- Item type keys (`type: dishwasher`) are a public contract: never rename one, add an alias in the catalogue instead. Unknown types render as the fallback box and appear in the problems list.
- **Read every frontmatter value as a string**, then let Pydantic parse dates. PyYAML's default loader uses YAML 1.1, which turns `serial: 0123` into the integer 83 (octal), drops leading zeros from numeric serials, and reads `model: no` as `false`. Use `yaml.BaseLoader` or an equivalent. On write, quote string fields whose value would otherwise parse as another type.
- **Write with minimal diffs.** `python-frontmatter` re-dumps the whole block through PyYAML, which drops comments and changes quoting and key order. Every save from the app would rewrite the whole frontmatter in git and Obsidian history. Use `ruamel.yaml` round-trip mode, or replace only the changed lines. Splitting on `---` takes a few lines of code, so the dependency can go.
- Accept the tag in every form Obsidian writes (`tags: housebook`, `[housebook]`, a block list, with or without `#`). **Adopt only notes inside the notes folder**, so a `type:` key in an unrelated note elsewhere in the vault is never touched. Write the adopted id when the user first opens or places the note, not in a startup sweep while Obsidian may have the files open.

### 15.5 File watcher

- **Use `watchfiles`** (Rust `notify`, asyncio-native, built-in debounce; uvicorn `--reload` uses it) instead of `watchdog`. No thread-to-event-loop bridging, and a `force_polling` switch for network filesystems (D10).
- Watch only the data root. Ignore `.housebook/**`, `.obsidian/**`, `.trash/**`, `.stfolder`, `.stversions/**`, `.syncthing.*.tmp`, `~syncthing~*.tmp`, `*.tmp`, `*.swp`, `*~`, `4913` (vim), `.DS_Store`, `.~lock.*`, `*.crdownload`, and dot-files in general.
- Debounce per path (300–500 ms). Obsidian saves about every 2 s while typing, so expect bursts. If parsing fails, retry once after 1 s before flagging the note.
- **Self-triggered events:** compare the file's content hash with the hash the app just wrote (the index already stores `hash`). If they match, update the mtime and send nothing. Time-window suppression misses slow disks and also hides real external edits.
- Every event carries the new ETag. Clients ignore events whose ETag matches what they already hold.
- **The watcher is only for speed; rescans are for correctness.** Rescan fully at startup (already planned) and every 10 minutes. A full scan of a few hundred notes takes well under a second.
- **Network filesystems** (NFS, SMB, 9p, Docker Desktop shares, NFS-backed k3s storage classes) don't deliver inotify events for changes made by other clients. Add `HOUSEBOOK_WATCH=inotify|poll|off` with a poll interval.
- **Sync conflict files:** Syncthing `*.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.md`; Nextcloud, Dropbox and Obsidian Sync `* (conflicted copy …).md` / `(Conflicted copy …)`. Index them as conflict copies (duplicate-id rule in 15.2), not as new items.
- **One process only.** The watcher, the SSE fan-out and in-memory state all assume a single process. Run uvicorn with one worker. On k3s use `replicas: 1` with `strategy: Recreate`: a RollingUpdate starts a second pod on the same volume, and with an RWO volume on another node it hangs on Multi-Attach. At startup take an exclusive `flock` on `.housebook/lock` and exit if it is held (log a warning on NFS, where flock is unreliable).

### 15.6 Editing alongside Obsidian

- ETags protect app-vs-app edits only; Obsidian doesn't send `If-Match`. If a note has unsaved edits open in Obsidian when the app writes it, Obsidian may overwrite the app's change on its next autosave. The window is about 2 s. Accept it, and shape writes so it rarely matters:
  - `PATCH` uses JSON Merge Patch (RFC 7396) on frontmatter (`null` deletes a key); `body` is replaced only if present. The server applies the patch to the current file under a per-file lock, after checking `If-Match` against the current hash.
  - Add `POST /api/items/{id}/log` to append `- YYYY-MM-DD text` under `## Maintenance log` (and create the heading if missing). Appends merge trivially, so the most common household write needs no `If-Match` and never conflicts.
- **Markdown editor:** WYSIWYG editors (Milkdown, TipTap) normalise Markdown on save (list markers, escaping, tables) and don't understand Obsidian syntax: `[[wikilinks]]`, `![[embeds]]`, callouts `> [!note]`, `%%comments%%`, block ids `^abc`. One save from the app can rewrite a note the user maintains in Obsidian. Use CodeMirror 6 source editing (the same engine Obsidian uses) with a rendered preview (D11). It is also a smaller bundle.

### 15.7 SSE behind reverse proxies

- Send a heartbeat comment (`: ping`) every 20–25 s. Idle timeouts: nginx `proxy_read_timeout` 60 s by default, Cloudflare 100 s, many load balancers 60 s.
- Response headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no` (nginx honours it). nginx: `proxy_buffering off; proxy_http_version 1.1; proxy_read_timeout 1h;`. ingress-nginx: the `proxy-buffering: "off"` and `proxy-read-timeout` annotations. Traefik (the k3s default) streams fine; make sure no compress middleware applies to `text/event-stream`.
- Use HTTP/2 at the proxy. Over HTTP/1.1 browsers allow 6 connections per host and each open tab holds one SSE stream, so a sixth tab stalls the app.
- **No event log and no `Last-Event-ID` replay.** On every (re)connect the server sends a `resync` event with the current house ETag and the item index version. The client refetches only what differs.
- **Expired auth:** `EventSource` can't see a 401 or a 302 to Keycloak; it just errors and retries forever. On `error`, call `/api/me`; on 401, reload the page so the proxy can re-authenticate.
- Server side: give each client a bounded queue, drop the client when its queue is full (a phone in the background), and unregister on disconnect.
- **Overkill check:** for one household, polling `GET /api/snapshot` with `If-None-Match` every 30 s and on window focus would also do. Keep SSE, but have the client fall back to polling after repeated SSE errors. Proxy trouble then costs latency, not correctness.

### 15.8 API additions

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/snapshot` | House + all item summaries (frontmatter, status, body) in one response with ETag. Used for first load, offline cache and client-side search. 300 notes × 2 KB ≈ 600 KB raw, ~150 KB gzipped |
| GET | `/api/me` | Current user and role |
| GET | `/api/problems` | Integrity report (15.2) |
| POST | `/api/items/{id}/log` | Append a maintenance log entry (15.6) |
| DELETE | `/api/items/{id}/attachments/{name}` | Remove an attachment (to trash) |
| GET | `/healthz`, `/readyz` | Liveness; readiness = first scan done and data root writable |
| GET | `/i/{id}` | Stable deep link for QR stickers; served by the SPA route. Stickers outlive URL redesigns |
| GET | `/api/calendar.ics` | Read-only feed of `next_check` and `warranty_until` (Q3). Calendar apps can't do OIDC, so this needs a per-user revocable token in the URL and a proxy auth bypass for this one path |

- SPA fallback: any GET outside `/api` returns `index.html`. Hashed assets get `Cache-Control: public, max-age=31536000, immutable`; `index.html` and `sw.js` get `no-cache`.

### 15.9 Search and index (overkill check)

- With a few hundred notes FTS5 isn't needed: a linear scan in Python takes milliseconds, and the frontend already has `domain/search`. Search has to work offline (15.11), so it must run in the client anyway. Proposal (D9): in v1 the backend keeps an in-memory index (id → path, hash, parsed frontmatter, status); search runs on the client over the snapshot; `GET /api/items?q=` uses the same simple matching for scripts. Keep the `SearchIndex` port so SQLite/FTS5 can return if notes reach the thousands.
- If SQLite stays: move it out of the data root (`HOUSEBOOK_CACHE_DIR`, default `/cache` on its own volume or tmpfs). Inside a vault, Syncthing syncs `index.db` together with its `-wal`/`-shm` files mid-write, and SQLite locking is unreliable on NFS/SMB. Use the `unicode61 remove_diacritics 2` tokenizer plus a trigram table for infix matches on model numbers, and test with accented Greek.
- Matching rules either way: ignore case and accents (`ψυγείο` = `ΨΥΓΕΙΟ` = `ψυγειο`: NFD, strip combining marks, casefold); match substrings in model, serial and error codes (`E15`, `SMS4HV`). Rank name, then error codes in "Quick help", then model/brand, then body.

### 15.10 Frontend performance on phones

- **Budget:** initial JS ≤ 200 KB gzipped (shell, 2D plan, list, details, search). three + react-three-fiber + drei is roughly 250–350 KB gzipped by itself. Load the 3D view with `React.lazy` when it is first opened. Phones default to 2D, so most household visits never download three.js. Lazy-load the Markdown editor in edit mode too. Enforce the budget in CI (`rollup-plugin-visualizer` plus a size check).
- Import drei by module path. Don't pull in `postprocessing` for hover outlines; use drei `<Outlines>` or an emissive highlight.
- `frameloop="demand"`: render only on input or state change. Continuous rendering of a static scene drains phone batteries. Cap `dpr={[1, 2]}`.
- Merge all walls of a floor into one `BufferGeometry` (one draw call), as already done for floors.
- **Instancing is not needed.** A home has tens to low hundreds of items; draw calls are not the bottleneck. If it ever is, use drei `<Instances>` per model type.
- **Models:** Kenney GLBs are a few KB to a few tens of KB each and share one palette texture, so the whole set stays well under 2 MB. The Draco decoder (~300 KB of WASM) costs more than it saves. Use `gltf-transform` `dedup`, `prune`, `weld`, and optionally `meshopt` (small decoder) or no compression at all. Load per type on demand, preload only the types on the current floor, and use content-hashed filenames with immutable caching.
- drei `<Html>` badges create one DOM node per item and reposition them every frame. Beyond ~30 items, use `<Html>` only for the selected or flagged items and sprites for the rest.
- iOS drops the WebGL context under memory pressure and in background tabs. Handle `webglcontextlost`: fall back to 2D and show a "reload 3D" button.
- Measure on a real mid-range Android over Wi-Fi, and aim for Lighthouse mobile ≥ 80 on the 2D view.

### 15.11 Offline and the emergency case

"Where is the fuse box?" usually comes up when the power is out: the server, the router and maybe the internet are all down. An online-only app fails exactly in the use case §3 lists for emergencies.

- **Printable emergency sheet first**, because it is the cheapest and most reliable fix: a `/print/emergency` page with the plan of each floor and the critical items (catalogue default for main water valve, fuse box, gas valve, boiler, router; override with `critical: true` in frontmatter), each with its location and quick help. Print it and stick it inside the fuse box door. Reprint when it changes; the attention list can remind the owner when the printed version is older than the data.
- **PWA** (`vite-plugin-pwa` / Workbox): precache the app shell; cache `/api/snapshot` (stale-while-revalidate); read-only offline mode with an "Offline, data from <time>" banner. Attachments are offline only when the user asks ("keep offline"), by default only for critical items' PDFs.
- **Auth interplay:** through oauth2-proxy, a navigation request returns a 302 to Keycloak when the session has expired or Keycloak is down. The service worker must serve the cached shell when the network answer is a redirect, opaque, an error, or slower than ~3 s (network-first with fallback).
- **iOS** may evict storage for sites not added to the home screen after about 7 days without use. Have household members install the app to the home screen, and call `navigator.storage.persist()`.
- **LAN reachability without internet:** if the hostname only resolves through public DNS, LAN access dies with the internet. Use split-horizon DNS (router, Pi-hole, AdGuard). A certificate from DNS-01 validation keeps working offline. Keycloak at home keeps login working without internet.
- Offline editing is out of scope for v1: it needs sync and merge logic that one household doesn't need.
- Viewer home screen: search-first ("Where is…?") with big buttons for the critical items.

### 15.12 Accessibility of the 3D UI

- The canvas is a black box to screen readers and to keyboard users. Instead of making the 3D view accessible, provide accessible alternatives: (1) the 2D SVG plan, with a `<title>` per room and focusable, labelled item buttons; (2) a list view Floor → Room → Item, fully keyboard-navigable. The list is also the best viewer UX on phones.
- Keyboard editing with a tile cursor: arrow keys move, Enter applies the tool, R rotates, Delete removes, Esc cancels, Ctrl+Z / Ctrl+Shift+Z undo and redo. A `?` overlay lists the shortcuts.
- Status never by colour alone: an icon plus text ("Overdue", "Due soon", "Warranty ends in 23 days"). Red/orange is a common colour-blind confusion pair.
- Room label colour picked for contrast against the room colour (4.5:1).
- Respect `prefers-reduced-motion` (no camera tweens) and `prefers-color-scheme`.
- Touch targets ≥ 44 px; in view mode the hit area of an item is larger than its model.
- Details panel: focus moves into the panel on open and back to the item on close; Esc closes.
- Run axe in Playwright on the 2D and list views (it can't check the canvas). `@react-three/a11y` is optional and low priority.

### 15.13 Security details

Attachments:
- Allowlist by sniffed type (magic bytes via `filetype` or `puremagic`), not by extension or by the client's `Content-Type`: PDF, JPEG, PNG, WebP, HEIC.
- Response headers: `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox` for images. Some browsers refuse to show a PDF under `sandbox`; test inline PDF preview in Chrome, Firefox and Safari, and if it breaks, render PDFs in the app with PDF.js instead.
- HEIC: iPhones upload it, and only Safari displays it. Convert to JPEG on upload (`pillow-heif`), or keep the original and generate a JPEG preview.
- Strip EXIF GPS from photos on upload. Appliance photos carry the home's coordinates, which matters once exports or public QR links exist. Cheap with Pillow.
- Stream uploads to disk and enforce the size limit in the app and in the proxy. nginx's default `client_max_body_size` is 1 MB, so manual uploads fail with 413 until it is raised (e.g. `50m`; on ingress-nginx, the `proxy-body-size` annotation).
- Serve files with Starlette's `FileResponse`, which supports Range requests (needed for large PDFs on phones).

Paths and Markdown:
- `Path.resolve()` follows symlinks. Check `resolved.is_relative_to(root.resolve())` after resolving, and reject symlinks inside the vault that point outside it. Reject names containing NUL, `/`, `\` or a leading `.`.
- Render Markdown with `react-markdown` without `rehype-raw` (or with DOMPurify). Allow only `http`, `https`, `mailto`, `tel` and `obsidian` URLs, in the body and in URL frontmatter fields (`manual`, `support`): a `javascript:` URL typed in Obsidian must not become a clickable link. External links get `rel="noopener noreferrer"`. `![[embeds]]` resolve only to files under the data root.

Auth (`HOUSEBOOK_AUTH_MODE=none|proxy|oidc`):
- **proxy** (oauth2-proxy + Keycloak, the natural fit here): trust `X-Forwarded-User` / `X-Forwarded-Groups` only from the proxy. Don't publish the container port; keep it on an internal Docker network or a ClusterIP Service, and optionally check the source address against `HOUSEBOOK_TRUSTED_PROXIES`. Header spoofing is the classic failure of this pattern. Stronger: have oauth2-proxy pass the access token and verify the JWT against Keycloak's JWKS.
- Map Keycloak groups to roles: `housebook-editors` → editor, any other authenticated user → viewer.
- **none**: everyone is a viewer unless `HOUSEBOOK_ANON_ROLE=editor` is set explicitly, so a LAN-wide open editor never happens by accident.
- Give household members long Keycloak sessions on phones ("remember me", ~30 days). Frequent logins will stop them from using the app.
- **CSRF:** writes are cookie-authenticated. Keep the session cookie `SameSite=Lax` (oauth2-proxy default) and require `Content-Type: application/json` on JSON writes and a custom header (`X-Housebook: 1`) on multipart uploads.
- **QR links (Q4):** v1 uses the authenticated deep link `/i/<id>`. Item ids (`it_` + 6 base36 characters ≈ 31 bits) are not secrets; never use them as access tokens. If public links come later: a random 128-bit token per item in `.housebook/shares.json`, revocable, exposing only an allowlisted subset of fields (name, type, quick help; no serial, receipts or purchase dates).
- `/api/export` is editor-only (it contains receipts and serial numbers), streamed (no in-memory zip), and excludes the cache.
- **Not needed:** rate limiting, a WAF, an audit trail beyond access logs and the write log in 15.14.

### 15.14 Observability, operations and backups

- **Logs:** JSON to stdout, one line per write (user, item id, path, result). Watcher events at debug level. Docker or k3s collects the rest.
- **Health:** `/healthz` and `/readyz`; a Dockerfile `HEALTHCHECK` using `python -c` with `urllib` (the slim image has no curl); liveness and readiness probes on k3s. Point Uptime Kuma or the existing monitor at `/readyz`.
- The problems panel (15.2) is the observability that matters to users. A Prometheus endpoint isn't needed; if wanted, a few gauges (items, problems, last scan duration, SSE clients) are enough.
- **Run as the host user**, not root: `user: "1000:1000"` in compose, `securityContext.runAsUser/runAsGroup/fsGroup` on k3s. In Obsidian mode, files written as root become read-only for Obsidian on the host. Use a read-only root filesystem with only the data and cache paths writable.
- **Mount directories, not single files.** A bind-mounted single `house.json` can't be replaced by rename (`EBUSY`).
- **Backups:**
  - The data root is the backup unit (§10). Exclude the cache (and `.housebook/index.db*` if SQLite stays inside it).
  - Nightly restic or borg with retention, or whatever already backs up the vault. Git history is attractive, but don't build it into the app; a host cron with `git add -A && git commit` does it (exclude large attachments or use git-lfs).
  - Safety nets that don't depend on backups: layout history (15.2), and `.housebook/trash/` kept for 90 days and purged at startup.
  - Test a restore once and write it in the README: delete the cache, restore the folder, start the container, check the problems panel is empty.
- Python: 3.12 receives only security fixes now; start a new project on 3.13 or 3.14.

### 15.15 Testing the 3D layer and the file layer

- Keep logic out of components: pointer → cell (unproject + plane intersection), wall edges, footprint rotation and mount height are pure functions that take camera matrices. Unit-test them in vitest with three's math classes; no WebGL needed.
- Scene-graph tests with `@react-three/test-renderer`: for a fixture house, assert the number of wall meshes, item positions and rotations, and the selection state. No GPU needed.
- Property tests (fast-check): `undo(apply(s)) == s` for every command; paint-then-erase restores the state; `house.json` serialise → parse round-trips.
- **E2E:** in non-production builds expose a test hook (`window.__housebook = { cellToScreen, store }`) so Playwright clicks exact cells instead of guessed pixels. Run 3D tests in Chromium with SwiftShader inside the pinned Playwright Docker image.
- Visual regression: only a few screenshots (empty floor, sample house, selected item) with a fixed viewport and DPR, `frameloop="demand"`, animations off and a pixel tolerance. These are the flakiest tests; keep them few.
- **Shared golden fixtures:** `fixtures/status_cases.json` (today, `next_check`, `warranty_until` → expected status) run by both vitest and pytest so the TS and Python status rules can't drift. Same for search matching, including Greek accents.
- **"Nasty vault" fixture** for backend tests: CRLF, UTF-8 BOM, no frontmatter, broken YAML, `serial: 0123`, duplicate ids, a Syncthing conflict copy, NFD Greek filenames, a half-written file, a symlink out of the root, a 0-byte file.
- Watcher tests on a real temp directory: Obsidian-style in-place writes (3 in quick succession), Syncthing-style temp file + rename, rename as delete + create. Assert one event each and no echo of the app's own writes.
- Contract: CI fails if the generated `openapi-typescript` client differs from the committed one.

### 15.16 Other gaps

- **Wall items vs cut-away walls.** §7.4 mounts wall items at ~1.8 m, but walls are cut at ~1 m by default, so boilers and fuse boxes float in the air. In cut-away mode, place wall items just below the cut height; use the real height with "walls up". Pick the wall edge from the item's rotation (back of the item against the edge); this also settles corner tiles with two walls.
- **Coordinate convention.** Write down once, in `domain/`, that `house.json` `y` maps to three.js `z` and which direction is +y. Mirrored plans are the most common early 3D bug.
- **Footprint anchor (Q1).** Define it now, even if v1 only ships 1×1: `(x, y)` is the minimum corner of the occupied rectangle after rotation; rotation by 90° swaps `w` and `d`. Occupancy checks stay simple.
- **Stacking (Q2).** Allow several items per tile. Repeated clicks cycle through them and a tile popover lists them. No `elevation` field until it's needed.
- **Recurring checks.** Add an optional `check_every: 6m` (or `1y`). When a log entry is added, propose `next_check = entry date + interval`. Without it, `next_check` goes stale after the first service and the attention list stops being trusted.
- **"Today" in the household time zone.** `HOUSEBOOK_TZ` (default: `TZ`), used by backend and frontend. The container default is UTC.
- **First run** is in milestone 5 but not specified. On an empty data root: create `house.json` (schema v1, one floor, 16×10), the notes folder and `.housebook/`. If tagged notes already exist, show them in the Unplaced tray.
- **Obsidian deep links** need the path relative to the vault root: `obsidian://open?vault=<name>&file=<path>`. The container only sees the data root, so add `HOUSEBOOK_OBSIDIAN_VAULT_SUBPATH` (e.g. `Housebook`). Render `[[wikilinks]]` and `![[embeds]]` in the app's preview for parity.
- **Link rot.** Manufacturer manual URLs move. The item panel should make "attach the PDF" the easy path (one tap), with the link secondary. No server-side URL fetching (SSRF risk, and already a non-goal).
- **UI language.** Keep strings in one place from day one, even if only English ships (see Q7).

### 15.17 Over-engineering check

| Item | Verdict |
|---|---|
| SQLite + FTS5 index | Overkill for v1. In-memory index + client-side search (D9) |
| Draco compression, instancing | Not needed at this model count and size |
| Prometheus metrics, rate limiting, WAF | Not needed; health endpoints + problems panel |
| SSE event replay / `Last-Event-ID` | Not needed; `resync` on connect |
| Cross-file transactions / journal | Not needed; single writer + write order + visible states |
| Ports and adapters (backend) | Fine as cheap `Protocol`s, but one adapter each. Don't add storage backends speculatively |
| Commands with undo, ETags, atomic writes, derived state | Earn their keep. Keep them |

### 15.18 Open questions (updated)

Recommendations for the existing questions:
1. Footprints: ship 1×1 in v1, but fix the anchor rule now (15.16).
2. Shared tiles: yes, with click-to-cycle (15.16).
3. Reminders: an ICS feed. Calendars already do notifications; no push or email infrastructure needed.
4. QR: logged-in deep links in v1; tokenised public links later if needed (15.13).
5. Note deleted in Obsidian: keep the placement as a "missing note" ghost (15.2).

New:
6. Who uses it on phones, and how do they log in: a Keycloak account per household member, or LAN-only viewer access?
7. UI language(s): English only, Greek, or both?
8. Will there ever be a second property (holiday home, parents' flat)? If so, run one container per house; don't add multi-house to the model.
9. Is cost tracking wanted in the maintenance log (e.g. `85 €`)? If so, fix a log line format now.
10. Where does Obsidian run relative to the server: same host (bind mount) or another device via Syncthing / Obsidian Sync? This decides the watcher mode and how urgent conflict-copy handling is.

### 15.19 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Server down during a power cut, exactly when the fuse box is needed | High | High | Printed emergency sheet, PWA offline snapshot (15.11) |
| WYSIWYG editor rewrites Obsidian syntax in curated notes | High (if WYSIWYG) | Medium | CodeMirror source editor, append-only log endpoint (D11) |
| Sync conflict copies or duplicated notes create duplicate ids | Medium | Medium | Canonical-file rule, problems panel, no auto-fix (15.2) |
| YAML 1.1 coercion corrupts serial/model numbers | Medium | Medium | String-only loader, quoted writes (15.4) |
| Accidental erase + autosave loses the layout | Medium | Medium | Layout history in `.housebook/history/` (15.2) |
| Files written as root become read-only for Obsidian | High (default Docker) | Medium | Run as host UID/GID (15.14) |
| inotify silent on NFS/SMB storage | Medium (k3s) | Medium | `HOUSEBOOK_WATCH=poll`, periodic rescan (15.5) |
| Two instances on one data root during a rollout | Low | High | `Recreate` strategy, one worker, `flock` (15.5) |
| SSE broken or stalled behind a proxy | Medium | Low | Heartbeat, buffering off, HTTP/2, polling fallback (15.7) |
| Uploads fail with 413 behind nginx | High | Low | Raise `client_max_body_size` / `proxy-body-size` (15.13) |
| Attachment XSS (SVG, HTML, sniffing) | Low | High | Sniffed allowlist, `nosniff`, CSP sandbox (15.13) |
| TS and Python status rules drift apart | Medium | Low | Shared golden fixtures (15.15) |
| 3D drains phone battery or loads slowly | Medium | Medium | Lazy 3D, `frameloop="demand"`, 2D default (15.10) |
| iOS evicts the offline cache | Medium | Medium | Home-screen install, `storage.persist()` (15.11) |
| Manual links rot | High | Low | Encourage PDF attachments (15.16) |
| 3D polish crowds out the useful parts | High | Medium | Build plan reorder (15.20) |

### 15.20 Build plan changes

The original order builds the 3D editor before the backend, but the editor's save, conflict and sync behaviour depends on the API. The riskiest parts (watcher, multi-writer files, Obsidian round-trips) come last and have the smallest estimates. Recommended order:

| # | Milestone | Content | Estimate |
|---|---|---|---|
| 0 | Data contract | `house.json` v1 schema (incl. `openings`), frontmatter spec, JSON Schema, nasty-vault fixtures, status golden fixtures | 0.5–1 day |
| 1 | Walking skeleton | Read-only backend (scan, id index, `/api/snapshot`, attachment GET), 2D plan + list + details, Docker image, health endpoints | 2–3 days |
| 2 | 3D viewer | Lazy-loaded scene, floors, merged walls, box models, click → details | 1–2 days |
| 3 | Real models | Kenney models, catalogue with footprint/mount/rotation, wall-item heights | 1 day |
| 4 | Writes and sync | `PUT /api/house` with ETag + validation + history, item create/patch/delete/log, single-writer rule, watcher (`watchfiles`), SSE + polling fallback, problems panel | 3–4 days |
| 5 | Editor | Paint/erase/place/move/rotate in 2D and 3D, rectangle paint/erase (drag), resize house grid (D17), undo/redo, replay on 412, Unplaced tray | 5–6 days |
| 6 | Notes and files | CodeMirror editor + preview, templates, uploads (sniffing, HEIC), first run, auth modes | 3 days |
| 7 | Offline and emergency | Emergency print page, PWA snapshot cache, ICS feed | 2 days |
| 8 | Polish | Attention list, doors/windows, wall fading, phone UX, a11y pass | ongoing |

The original milestones 1–5 add up to 7–10 days; this plan is about 17–21 days. The difference is mostly hardening that the original estimates left out (watcher edge cases, conflicts, validation, offline), not new features. If building the 3D viewer first is kept for motivation, still do milestone 0 first: the schema and fixtures are what keep later rework cheap.

### 15.21 Additional decisions

| # | Decision | Reason |
|---|---|---|
| D8 | `house.json` has a single writer (`PUT /api/house`); item endpoints never touch the layout. Create = note then placement; delete = placement then note. Unplaced and missing-note are normal UI states | Removes the autosave race; any crash leaves a harmless orphan; no cross-file transactions needed |
| D9 | v1 index in memory; search runs on the client over `/api/snapshot`. SQLite/FTS5 deferred behind the `SearchIndex` port and, if added, kept outside the data root. *Proposed; amends D2* | Household scale; search must work offline anyway; avoids SQLite on synced or network filesystems |
| D10 | `watchfiles` instead of `watchdog`; one process, one worker, one replica (`Recreate`); periodic full rescan as the correctness path; content-hash echo suppression | Async-native with built-in debounce and polling; the watcher, SSE and in-memory state assume a single process |
| D11 | CodeMirror 6 source editor with preview instead of a WYSIWYG editor; `POST /api/items/{id}/log` for log entries | WYSIWYG round-trips rewrite Obsidian syntax; smaller bundle; appends never conflict |
| D12 | Frontmatter read as strings and written with minimal diffs (`ruamel.yaml` round-trip or line edits); unknown keys kept; changes additive only; no per-note version key | Prevents YAML 1.1 coercion bugs and noisy diffs in Obsidian and git |
| D13 | Backend-owned `house.json` migrations; a newer `schemaVersion` opens read-only | Safe image rollbacks; frontend only handles one version |
| D14 | Printable emergency sheet + read-only PWA offline snapshot; no offline editing | The main emergency happens when the server is down; read-only offline needs no sync logic |
| D15 | 2D plan + list view are the baseline (phones, accessibility); 3D is lazy-loaded with `frameloop="demand"` | Bundle size and battery on phones; the canvas isn't accessible |
| D16 | QR stickers point to authenticated deep links `/i/<id>` in v1 | Item ids aren't secrets; stable URLs outlive redesigns; public sharing can be added later with real tokens |
| D17 | Editor adds (a) rectangle paint/erase: drag from one tile to another to paint or erase the whole rectangle as one undo step; (b) resize house: grow or shrink the grid on any side. Growing north or west shifts every cell, placement and opening so nothing moves visually. Shrinking that would cut painted tiles, placements or openings shows what would be lost and needs confirmation; it is one undo step. `tileSize` changes stay out of the editor | Painting rooms tile by tile and hand-editing `grid.width`/`depth` is the main pain in hand-made layouts (user request, 2026-11-05) |
| D18 | Default cut-away walls are ~0.3 m instead of ~1 m, and camera-facing wall fading moves from milestone 8 to milestone 2 | At a 45° tilt a 1 m wall hides the 1 m tile row behind it; the main water valve was invisible in tester run M2-03 (user decision, 2026-11-05) |
| D19 | Change handling (milestone 4): every change (API write, watcher batch, periodic rescan) runs one full rescan under one lock, then diffs against what clients were last told. The watcher (`watchfiles`, native events) closes a batch after a 400 ms quiet window (at most 2 s) rather than debouncing per path. `HOUSEBOOK_WATCH=poll` is a full rescan every `HOUSEBOOK_POLL_INTERVAL` (default 5 s), not watchfiles' polling. One global write lock instead of per-file locks | A scan is milliseconds and hashes every note, so there is no per-path index update to get wrong and echo suppression falls out of the diff. watchfiles' poller compares mtimes and missed a second save shortly after the first in tests. One process, one household: a global lock costs nothing |
| D20 | Write HTTP conventions: `If-Match` is required on `PUT /api/house`, `PATCH` and `DELETE` (`428` without it) and is compared with the hash of the file **on disk**; `*` overwrites; `If-None-Match: *` creates a missing `house.json` (both headers evaluated in RFC 9110 order). Role and body size (17 MiB house, 25 MiB otherwise) are checked in a middleware before any body is read. Quoted, unquoted and `W/` ETags are accepted. `409` + `reason` when the target can't be written (read-only house, unparseable note), `415` without a JSON content type, `422` as `{detail: [{type, loc, msg}]}` (semantic `type`s = `house_*` problem kinds). Log append and adopt need no `If-Match`. On a `412` the index is rescanned before answering | The index can lag the disk by the watcher's quiet window; judging the disk closes that gap. Same error shape as FastAPI's own validation errors, so the client has one parser |
| D21 | `DELETE` moves the note and its sibling attachment folder (unless it holds notes) to `.housebook/trash/<stamp>-<id>/`, purged after 90 days at startup. `POST /api/items/adopt {path}` writes a new id on the first frontmatter line of a note that the last scan reported as `not_adopted` (nothing else). Paths in responses, events and problems are NFC. Notes keep their BOM, CRLF endings, quote and list styles on every write | Deleting a note without its attachments leaves orphans in the vault. Adoption needed an explicit endpoint since the client only sees adoptable notes through the problems list |
| D22 | SSE events: `resync {houseEtag, houseReadOnly, itemsVersion, problemCount}` on connect, `house.changed {etag, readOnly}`, `item.changed {id, etag, path, stale}`, `item.deleted {id}`, `problems.changed {count}`. `itemsVersion` (hash of every item's id/etag/path/staleness/attachments) is also in `/api/snapshot`. `problems.changed` is held while an item is in its delete grace period or parse retry. App writes are announced too (other tabs need them). The heartbeat is a `ping` event, not a `: ping` comment (EventSource hides comments; the client watchdog needs an event). SIGTERM ends all streams at once (uvicorn otherwise waits for them forever), with a 5 s graceful-shutdown backstop | The client compares two values on reconnect instead of refetching everything; holding problems back keeps a rename from flashing "missing note" in the problems badge |
| D23 | *Proposed (milestone 5).* UI text lives in `apps/web/src/strings/`, one module per area (`strings/editor.ts` first); functions take the values they interpolate. Older components keep their inline English until they are next touched | There was no central place yet (15.16 "UI language"); per-area modules keep the editor's many strings out of the components without a translation framework |
| D24 | *Proposed (milestone 5).* Layout commands (`src/commands/`) are plain-data intents: `cells` (paint/erase/rectangle), `placement` (place/move/rotate/remove, with `requires: placed \| unplaced`), `room.add/update/remove`, `openings`, `resize`, `dedupe` ("Keep the first", D30: removes the 2nd and later placements of an item; its inverse puts them back at their old indexes; a no-op when placed once), `batch`. Repairs (D30) and their inverses carry `repair: true`; repairs that remove a placement name the exact copy (`match`, its undo re-inserts it with `insert`), since an item may be placed twice (M5-09); a missing room whose id isn't a valid id is recreated under a new id with its tiles moved to it (M5-08), which lets them restore exactly what was there (tiles of a missing room, things outside the grid or on a missing floor); ordinary edits can't create those. Undoing a resize also puts back content that was outside the grid before it. One pure `applyCommand(layout, cmd)` returns the new layout and the exact inverse, or a conflict. Undo applies the inverse; replay applies the pending commands to the fresh layout and recomputes inverses. An effect that is already there is a no-op, not a conflict (a save whose response was lost replays cleanly). Conflicts: the floor/room/placement a command needs is gone, a tile or footprint is outside the grid, an item to place was placed elsewhere, the grid size differs from the one the user resized, or a shrink would now cut more than was confirmed. A tile someone else painted differently is not a conflict: the later local edit wins. **Coordinates and other writers' resizes (M5-02):** when a layout from the server has a different grid size than the one the history and pending commands were made on, or the same size but the house moved (West +1 / East −1, or two resizes missed, M5-07), the shift is inferred (`inferShift`): the **geometry** (tiles, placements, doors/windows) must have changed exactly as a resize with only one possible shift would change it; changes to names and colours don't matter. A shift is only ever inferred when painted tiles or doors/windows confirm it, never from placements alone (items move on their own, M5-11): without tiles or openings, the same size means no shift and a new size is "can't tell" (dropped as below). For a same-size layout, ordinary edits by another writer don't count as a shift: a shift is only considered when it explains more of the old layout than no shift does. Then every pending command and history entry is translated by it (exact). Otherwise (ambiguous, or a resize combined with other geometry changes such as a painted tile or a moved item) the pending commands are dropped with "the house was resized elsewhere" and the history is cleared, with a message. A pending resize that is dropped drops every later pending command too (they were made in a grid that never existed on the server); an undo of a resize that no longer applies clears the rest of that stack | Undo, redo and replay on 412 share one mechanism; conflicts are about intent, not about byte equality, so unrelated changes by another writer never drop an edit |
| D25 | *Proposed (milestone 5).* Saving: `PUT /api/house` 1 s after the last edit, one request in flight, run in the data store's queue (so the `house.changed` echo of our own write is ignored). `412`: `GET /api/house`, replay, retry (up to 5 times). A `house.changed` while edits are pending is handled the same way (rebase, then save). Dropped edits leave the history and get a message that stays until dismissed. `422`/`409`/`403`/`413` stop autosave (Retry/Discard); network errors retry after 2/5/10/30 s. Leaving edit mode saves at once; `beforeunload` asks while anything is unsaved. A layout that turns read-only drops the unsaved edits with an error. A 412 whose refetched layout is read-only (`X-Housebook-Read-Only`) goes straight to that path, without replaying or retrying (M5-10). **Lost responses (M5-01):** a `PUT` that fails without an answer is remembered; if the server's layout (412 refetch or SSE) is exactly what was sent, it was saved: those commands are done, no replay. A replayed command that changes nothing keeps the inverse it was made with, so undo still works. **Undo after D30 repairs:** an undo or redo whose result has more of some problem than the last known server layout (`addsProblems`, the server's per-subject count) is refused with a message and the entry is skipped, so a repair can be undone only until it is saved | Single writer (D8, D20) with no silent loss (15.2); the queue gives a strict order between saves and events without locks |
| D26 | *Proposed (milestone 5).* The editor never deletes notes. Placing from the catalogue creates the note first (`POST /api/items`, room folder from the tile) and then adds the placement as an undoable command; undo removes only the placement, so the note lands in the Unplaced tray. "Remove from plan" (Delete key) also only moves an item to the tray. Ghost relink targets are unplaced notes; relink and remove are one undo step each | D8 write order; an undo that deleted a file would be a second writer path with no undo of its own. Note deletion belongs with the note editor (milestone 6) |
| D27 | *Proposed (milestone 5).* Pointer model in edit mode: the active tool takes single-pointer presses (paint/erase/place anywhere on the grid; select only on items), everything else (empty tiles with the select tool, outside the grid, wheel, a second finger) pans and zooms as in view mode. Select: a click selects the top item of a tile and a click on the selected item cycles through the stack (15.16); a drag moves the item by the tiles the pointer travelled, clamped to the grid. In 3D the select tool grabs the item under the pointer (react-three-fiber's hover picking, so raised wall items are grabbed where they are drawn); other tools use the floor-plane tile. Rotation is 90° clockwise in place (anchor kept, shifted back inside the grid if needed); new placements start at rotation 0 | One model for mouse and touch without a separate "hand" tool; deltas instead of absolute targets keep multi-tile items under the pointer |
| D28 | *Proposed (milestone 5).* Resize dialog: a signed tile count per side, the new size and the loss computed live; any loss is listed (tiles per room, items by name, doors/windows) and needs a "Remove these" tick. Cut placements go to the Unplaced tray (notes untouched); undo restores tiles, placements (in their stacking order) and openings. New rooms are `rm_` + 6 base36 characters named "Room N" with the first unused colour of a fixed palette; a room can only be deleted when no floor has tiles of it; consecutive recolours of a room are one undo step | Makes D17b's "shows what would be lost" concrete and keeps every resize reversible |
| D29 | *Proposed (milestone 5).* Edit-mode panels (side bar, resize and new-item dialogs) are a lazy chunk (~4 KB gzipped); the editor store, commands and tool pointer handling are in the main bundle (~10 KB gzipped) because both views use them. Edit mode is offered to editors at any width (the side bar stacks above the plan on phones); keyboard editing with a tile cursor stays in milestone 8 | Viewers download almost nothing extra (D15); a phone-specific editor isn't worth it before the a11y pass |
| D30 | *Proposed (milestone 5, from M5-03; amends the "Validate on `PUT`" bullet of 15.2).* **A save may not make the layout worse; it doesn't have to make it perfect.** Structure (Pydantic) and `house_bad_cell` are always enforced. The other semantic issues (`house_unknown_room`, `house_duplicate_placement`, `house_outside_grid`, `house_unknown_floor`, `house_duplicate_id`) are compared with the file **on disk** (as D20, so it also holds for `If-Match: *`; with no file, e.g. `If-None-Match: *`, everything is new): each issue gets a subject key without list indexes or coordinates — unknown room (floor, room id), duplicate placement (item id), placement outside the grid or on an unknown floor (item id), cells or openings outside the grid or on an unknown floor (floor), duplicate id (room/floor, id) — and `PUT` returns `422` (same shape, only the offending issues) when any key occurs more often than on disk. Semantic checks move from the route into `put_house`, under the write lock after the read-only check, so `428`/`412`/`409` come before a semantic `422`. The editor keeps `422` fatal (D25); it now means an editor bug. Repairs are offered in edit mode for problems found in the **editor's own layout** (so a button disappears as soon as it is used), each a command (D24, marked `repair`) saved by autosave, no new endpoint. A repair can be undone only until it is saved: the client refuses any undo/redo that would add a problem compared with the last server layout (the server would answer `422`), says so ("already saved, so it can't be undone"), and the next undo continues with the entry below (D25). After that, a repair is reversed by hand or from `.housebook/history/`; the lossless option is the first button wherever there is one: tiles of a missing room → "Recreate room" (`room.add`, same id, "Recovered room", next palette colour; no loss) or "Erase tiles"; item placed twice → "Keep the first" (the one shown; the `dedupe` command removes the later copies); outside the grid → "Grow to W × D" (one east/south resize, no loss) or "Remove what's outside" (tiles erased, items to the Unplaced tray, openings removed); unknown floor → item to the tray / opening removed. Duplicate room or floor ids get no button (which one is meant is a judgement; fix by hand); malformed cell keys need none (the server already normalised them and the next save writes them canonically) | Hand-edit leftovers made the whole editor unusable until the file was fixed by hand (M5-03), although the editor didn't cause them and could fix most of them. Counting per subject instead of comparing positions lets moves, resizes and replays (D24) through, while an editor bug that adds a bad tile or placement is still rejected. Repairs are explicit, as 15.2 requires. Undo checks the same "not worse than the server" rule as `PUT` instead of special-casing repairs, so the client never queues a save it knows will be rejected; an undo window of about 1 s plus layout history is enough at household scale |
| D31 | *Proposed (milestone 6).* **Note editor.** "Edit note" in the item panel (editors; not while the note is stale) swaps the panel to a form: name, brand, model, serial, purchased, warranty until, next check, check every, manual and support links, emergency item (type default / yes / no), and the body as Markdown with a preview. `type` and `attachments` are not in the form (a type change can change the footprint; attachments get their own UI). The form starts from the **raw** frontmatter strings (dates as `YYYY-MM-DD`; a date that isn't one is shown as a hint, not cleared), and a save sends a JSON Merge Patch of only the keys whose value differs from what was read (`""` → `null`, i.e. delete the key), plus `body` if it changed, with `If-Match` = the ETag the edit started from. On `412` the client fetches the item and **rebases**: keys the user didn't change take the new values, changed keys keep the user's; a key the other side changed to something else is a conflict. Without conflicts the save is retried (up to 3 rounds); with conflicts the form shows "theirs · yours" per key with "Use theirs", and the next Save keeps the user's values (`If-Match` = the new ETag, never `*`). Drafts are kept in memory per item (`features/details/drafts.ts`): closing the panel or opening another item keeps the edit, and the item reopens in the editor; a reload loses them, so the page asks before unloading while a draft has changes | Edits made at the same time in Obsidian and in the app usually touch different fields; merging per key keeps both without asking, and asks only when the same value changed twice. Sending only changed keys keeps the server's minimal diff (§3.6) minimal and never rewrites values the user didn't touch, such as an invalid date or a quoted serial. A plain textarea instead of CodeMirror keeps the bundle small; CodeMirror can come later if editing long notes needs it |
| D32 | *Proposed (milestone 6; completes D26).* **Delete item.** "Delete item" in the item panel (editors, view mode of the panel) opens a confirmation naming what happens: taken off the plan (when placed), the note and, if there is one, its sibling attachments folder moved to `.housebook/trash/` for 90 days, restored by moving them back. On confirm the client follows D8: every placement of the item is removed with the layout editor's ordinary `placement` command (so it is in the undo history and saved by `saveNow`, in or out of edit mode), the layout is saved, and only then `DELETE /api/items/{id}` is sent with the item's current ETag. If the layout can't be saved nothing is deleted; on `412` the note stays (it is now unplaced, in the tray) and the dialog says so. A new placement of an item whose note this app deleted is refused by the commands (`note_deleted`, via `ApplyContext.noteDeleted`, a set of ids kept for the session), so undoing "remove from plan" after a delete reports "its note was deleted" instead of creating a ghost; ghosts (notes missing for other reasons) are unaffected, so undoing a ghost relink or removal still restores the ghost. No in-app undo of the delete itself (it would need a restore endpoint) | Layout first means no "note missing" ghost ever appears, not even for a moment, and a failed save leaves everything as it was. Reusing the editor's command keeps one path for layout writes (replay on `412`, history) instead of a second writer. Refusing placements of missing notes in the command layer covers undo, redo and replay in one place |
| D33 | *Proposed (milestone 6).* **Uploading and removing attachments.** `POST /api/items/{id}/attachments?name=` takes the file as the raw body (`application/octet-stream`): no multipart parser, streamed to `.housebook/uploads/` (same filesystem as the data, ignored by the scanner) under the existing 25 MiB write limit, and not a type a cross-site form can send. The type comes from the first bytes (15.13 allowlist: PDF, JPEG, PNG, WebP, HEIC). PDFs are kept byte for byte; images are always decoded and saved again with Pillow (orientation applied, every bit of metadata dropped, colour profile kept, quality 90), which removes GPS and camera data without special-casing EXIF tags; HEIC/HEIF become JPEG (`pillow-heif`). Processing happens before the write lock; under the lock the file is linked into the item's attachments folder (no overwrite) and listed in `attachments` as a wikilink (15.3). No `If-Match`, like the log (D11). `DELETE /api/items/{id}/attachments/{name}` moves a file from the item's own folder to the trash and unlists it; files elsewhere are refused (`not_in_folder`) because a link may be shared. In the app: "Add files" (several at once) and dropping files on the Attachments section; "✕" then "Remove" per file | Re-encoding every image is simpler and safer than editing EXIF in place (no tag can be missed) and costs a little JPEG quality, which doesn't matter for appliance photos and receipts. Raw-body uploads keep the CSRF rule ("a type a form can't send") the API already has |
| D34 | *Proposed (milestone 6; specifies the "First run" bullet of 15.16).* When the snapshot has no layout and `houseReadOnly` is false, `house.json` is missing (an unreadable or newer file is always read-only, so it is never offered for replacement). Editors then see "Set up your house": a name for the first floor (default "Ground floor") and the grid in whole metres (default 16 × 10, 1–512 per side, tile 1 m). "Create the floor plan" sends `PUT /api/house` with `If-None-Match: *` and one empty floor (`fl_` id, level 0), reloads, opens the editor and adds "Room 1" with the paint tool, so the next step is to drag out the first room. A `412` (created meanwhile by someone else) just shows theirs. The card counts existing items (they wait in the Unplaced tray) and tagged notes without an id (`not_adopted`, adopted from the problems list). Viewers are told that someone who can edit can set it up. Nothing new on the server: `.housebook/` exists from the lock and the notes folder is created with the first note | The editor needs a layout to start from, so without this a new install was a dead end with no Edit button. Creating the file only when it doesn't exist (`If-None-Match: *`) keeps the rule that the app never overwrites a `house.json` it can't read |
| D35 | *Proposed (milestone 7).* **Editing floors.** Three layout commands (D24): `floor.add` (a floor at an index; as the undo of a removal, `restore` puts its placements and doors/windows back at their old indexes in house.json, refusing an item placed elsewhere meanwhile or one whose note this app deleted), `floor.update` (name, level) and `floor.remove` (the floor with its tiles, placements and openings; never the last floor, `last_floor`). `floor.remove` carries what the user confirmed (tile count, item ids, opening count); more on replay is `more_lost`, as for a resize. `shiftCommand` moves a `floor.add`'s tiles, placements and openings with the grid (M5-02). In the editor's side bar, "Floors" lists them highest level first: show, rename, move up/down (swaps the two levels, one undo step), delete (a dialog listing tiles per room, items going to the Unplaced tray and doors/windows; disabled for the last floor), and "+ Floor above" / "+ Floor below" (level max+1 / min−1 within −20…200; names "Floor N", "Ground floor", "Basement", "Basement N"). While editing, the 2D plan draws the walls of the next floor down, dashed and faint, under the current one, to trace an upper floor over the one below. All floors still share one grid | Floors were in the file format from the start but couldn't be created in the app. Commands keep undo, redo and replay on `412` working the same way as for rooms; the confirmed loss protects against deleting what someone else just put on the floor. The outline replaces a "copy floor" action, which would have copied room ids and made one room span floors (rooms are global) |
| D36 | *Proposed (milestone 7).* **Door and window tools.** Two editor tools, Door (D) and Window (W). Views pass the tile under the pointer and where in it the pointer is (`PointerCell.fx/fy`; the 2D plan from its transform, the 3D view from the ground-plane hit); `nearestEdge` picks the closest of the tile's four edges and stores it the house.json way (`n`/`w`; south = north of the tile below, east = west of the tile right of it). A click on an edge that is a wall (`isWallEdge`: on the grid, and the two tiles belong to different rooms or one is outside) adds the tool's kind, swaps the other kind, or removes the same kind, with the existing `openings` command (undo, replay); any other edge is refused with "Doors and windows go on walls". While hovering, the edge is highlighted: a thick line in 2D, a thin upright bar in 3D, red and dashed when it isn't a wall. No change to the file format or the server | Doors and windows were stored and drawn since milestone 5 but could only be added by editing house.json. Picking the nearest edge from the press position needs no new gesture and works the same with a mouse, a finger and in 3D; restricting them to walls avoids doors floating in the middle of a room, which the renderers can't draw sensibly |
| D39 | *Proposed (milestone 8; specifies the "Recurring checks" bullet of 15.16).* **Next check after a log entry.** After "Add" in the maintenance log form succeeds, an item with a valid `check_every` and an explicit `next_check` is offered the entry date (the form's date, else today in `HOUSEBOOK_TZ`) plus the interval (`suggestNextCheck`, months clamped as in §4), but only when that is later than the current `next_check`, so logging an old service never moves it back. The status line asks "Set the next check to 25 Nov 2027?" with "Set next check to …" and "Keep …". Setting it is a JSON Merge Patch of `next_check` only, with `If-Match` = the ETag the log entry returned; on `412` the item is fetched again and the patch retried once on the new ETag if `next_check` is still what was offered against, otherwise nothing is changed and the form says so. Items without an explicit `next_check` need nothing: their next check already follows the log (`derived`), and the form says where it moved. No server change | Without it, `next_check` goes stale after the first service and the attention list stops being trusted. Asking instead of writing keeps every write an explicit user action (15.2). Not removing `next_check` in favour of the derived date keeps what the user wrote in the note; patching only that key keeps the server's minimal diff |
| D38 | *Proposed (milestone 8).* **Attention list.** A third view next to Plan and List, "Attention", with the number of items that need attention today (status level set, data contract §4) on the switch. It lists one entry per thing to do, so an item can appear twice: **Overdue** (checks past their date, longest overdue first), then **Coming up** (checks due within 30 days and warranties ending within 60, merged by date; same date by name). Each entry shows the item, its room and floor (or "Unplaced"), what is due in words and the date, marked "(every 6m)" when the date comes from `check_every`; it opens the item like the List view. It is built in the browser from the snapshot with the same `currentStatus` the badges use (recomputed after midnight), follows the search, and moves between entries with the arrow keys. Expired warranties are left out (nothing to do). The choice of view is remembered as before. No server change: `GET /api/items?due=N` stays for other clients | One place to answer "what needs doing?" (goal G5) without scanning the plan for badges. One entry per date instead of one per item keeps the list sorted by what comes next. Building it from the snapshot keeps it live with every refresh and costs no request |
| D37 | *Proposed.* **Door and window models in 3D; walls stay generated.** The 3D view draws each opening on a wall with CC0 Kenney Furniture Kit parts (`src/assets/models/LICENSES.md`): a door frame (`doorwayOpen`) with the leaf of `doorway` (interior walls) or `doorwayFront` (exterior walls), and the window frame and pane cut out of `wallWindow` (`obj-to-glb.mjs --keep`). They are not items: `openingPlacements` (domain/scene.ts) places them in the gaps `wallGeometry` already cuts, and `openingFit.ts` stretches them to the gap (frame a little deeper than the wall, window set in at 60 % of it); the leaf keeps its own thickness ratio and stands open 70°, hinged on the low end and swinging into the tile the 2D plan's arc uses (`doorSwingsIntoKeyedTile`). With cut-away walls a door is clipped to the wall height (a local clipping plane), so it reads like the plan's swing; a window shrinks into the upper half of the low wall, as its pane did. In walls that fade ("walls up", facing the camera) they fade too. They never take a click. Until the parts load (and if they fail) the plain panes are drawn as before. The kit's wall pieces are **not** used. The catalogue gains `computer` (screen, keyboard and mouse merged with `--add`) and `laptop` | Doors and windows were only gaps and flat panes, easy to miss. Reusing the kit keeps one look with the appliances at ~22 KB for all four parts. The kit's walls are fixed 1-tile, fixed-thickness blocks: our walls are generated per edge with interior/exterior thickness and any tile size, merged into one mesh per floor, cut to 0.3 m or faded per camera heading, and split where openings are; tiles of kit walls would need all of that redone, cost a draw call per tile and look the same from above |
