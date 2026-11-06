# Housebook data contract (v1)

This is the contract between the files on disk, the backend and the frontend. Machine-readable
parts live in [`/contract`](../contract):

| File | What |
|---|---|
| `contract/house.schema.json` | JSON Schema of `house.json` v1, generated from the Pydantic model (`uv run housebook schema --out ../../contract/house.schema.json`). A test fails if it is stale. |
| `contract/catalog.json` | Item type catalogue |
| `contract/fixtures/status_cases.json` | Golden cases for status rules, "today" and `check_every` parsing |
| `contract/fixtures/search_cases.json` | Golden cases for folding, error-code extraction and search ranking |

Backend (pytest) and frontend (vitest) both run the fixtures. If a rule changes, change the
fixture first.

## 1. Data root layout

```
<data root>/                 HOUSEBOOK_DATA_DIR
  house.json                 layout (written only by PUT /api/house, from milestone 4)
  House/                     notes folder (HOUSEBOOK_NOTES_DIR); only *.md files here are items
    Kitchen/
      Dishwasher.md          one item
      Dishwasher/            sibling folder: attachments of Dishwasher.md
        manual.pdf
  .housebook/                app state, never synced as content
    lock                     single-process flock
```

Ignored everywhere: dot-files and dot-dirs (`.housebook`, `.obsidian`, `.trash`, `.stversions`,
`.syncthing.*.tmp`, …), `*.tmp`, `*.swp`, `*~`, `4913`, `~syncthing~*`, `*.crdownload`, `*.part`.
Symlinks are followed only if they resolve inside the data root; others are ignored and
reported (`symlink_outside_root`).

## 2. `house.json` v1

```json
{
  "$schema": "../../contract/house.schema.json",
  "schemaVersion": 1,
  "grid": { "tileSize": 1.0, "width": 16, "depth": 10 },
  "rooms":  [ { "id": "rm_kit", "name": "Kitchen", "color": "#E3A94B" } ],
  "floors": [ { "id": "fl_0", "name": "Apartment", "level": 0, "cells": { "7,1": "rm_kit" } } ],
  "placements": [ { "itemId": "it_7f3k2a", "floorId": "fl_0", "x": 10, "y": 2, "rotation": 90 } ],
  "openings":   [ { "floorId": "fl_0", "x": 8, "y": 5, "side": "n", "kind": "door" } ]
}
```

| Field | Type | Rules |
|---|---|---|
| `$schema` | string, optional | Kept as is. Points editors (VS Code) at the JSON Schema |
| `schemaVersion` | integer | `1`. See §2.3 |
| `grid.tileSize` | number, metres | `0 < tileSize ≤ 10`, default 1 |
| `grid.width`, `grid.depth` | integer | 1–512 tiles along x / y |
| `rooms[]` | `{id, name, color}` | Global, shared by all floors. `color` is `#RRGGBB` |
| `floors[]` | `{id, name, level, cells}` | At least one. `level` −20…200. `cells` maps `"x,y"` → room id |
| `placements[]` | `{itemId, floorId, x, y, rotation, footprint?}` | `rotation` ∈ {0, 90, 180, 270}. `footprint` `[w, d]` (each 1–512) overrides the catalogue |
| `openings[]` | `{floorId, x, y, side, kind}` | Doors and windows on tile edges. `side` ∈ {`n`, `w`}, `kind` ∈ {`door`, `window`} |

Ids (`rooms[].id`, `floors[].id`, item ids) match `^[A-Za-z0-9_-]{1,64}$`. The app generates
`rm_…`, `fl_…` and `it_` + 6 base36 characters, but any id matching the pattern is fine.
Unknown keys are rejected (`additionalProperties: false`), so typos in hand edits show up.

### 2.1 Validation

Structural rules (types, ranges, patterns) are always enforced. Semantic rules:

1. room ids and floor ids are unique;
2. at most one placement per item;
3. cell keys are `x,y` with non-negative integers, no padding (`"01,0"` is invalid);
4. cells lie inside the grid (`x < width`, `y < depth`);
5. every cell points to an existing room;
6. placements reference existing floors and their occupied rectangle lies inside the grid;
7. openings reference existing floors and lie on a grid edge (§2.2).

Loose cell keys in a hand-edited file are normalised when it is read: `"01,0"` and `" 1, 0"` are
served as `"1,0"`; keys that aren't two non-negative integers are dropped; a loose key that
collides with an existing canonical one is dropped. Each case is a `house_bad_cell` problem, so
the API never serves a key its own schema rejects.

`PUT /api/house` (milestone 4) rejects a layout that breaks any rule with `422`. A hand-edited
file that breaks semantic rules still loads; each issue becomes a problem
(`house_duplicate_id`, `house_bad_cell`, `house_outside_grid`, `house_unknown_room`,
`house_unknown_floor`, `house_duplicate_placement`). A file that fails structural validation
or isn't JSON keeps the last valid version in memory (`house_invalid`).

Serialisation when the server writes: 2-space indent, trailing newline, cell keys sorted by
`y` then `x`, `null` fields omitted.

### 2.2 Coordinates, anchors, rotation, edges

- Tile `(x, y)` covers `[x, x+1) × [y, y+1)` tiles, i.e. `× tileSize` metres. The origin is the
  north-west corner of the grid. **+x is east, +y is south.** The 2D plan draws +y downwards (SVG).
- three.js mapping: `house.x → three.x`, `house.y → three.z`, up is `three.y`. With the default
  camera looking north, +y (south) points towards the viewer. World position of a tile centre:
  `((x + 0.5) · tileSize, 0, (y + 0.5) · tileSize)`.
- **Rotation** is in degrees, clockwise seen from above. At `0` the item's front faces +y
  (south) and its back is against the **north** edge. three.js: `rotation.y = −rotation · π/180`,
  with models authored facing +z.

  | rotation | front faces | back against edge |
  |---|---|---|
  | 0 | south (+y) | north |
  | 90 | west (−x) | east |
  | 180 | north (−y) | south |
  | 270 | east (+x) | west |

  Wall-mounted items use the "back against" edge. This also settles corner tiles.
- **Footprint anchor:** `(x, y)` is the minimum corner of the occupied rectangle **after**
  rotation. Rotation by 90 or 270 swaps `w` and `d`. Occupied tiles: `x ≤ tx < x + w'`,
  `y ≤ ty < y + d'`. v1 ships 1×1 footprints only.
- Several items may share a tile (stacking). There is no `elevation` field.
- **Openings** sit on edges. Each edge has exactly one key: `n` is the edge between `(x, y)`
  and `(x, y−1)`, `w` the edge between `(x, y)` and `(x−1, y)`. The south edge of `(x, y)` is
  `n` of `(x, y+1)`; the east edge is `w` of `(x+1, y)`. So `x == width` is valid for `w`
  (east boundary) and `y == depth` for `n` (south boundary).
- An item's **room is derived** from the tile at `(x, y)` on its floor; it is never stored.
  Walls are derived from cells.

### 2.3 Versions and migrations

**Writable only when current and valid.** `house.json` may be written (by `PUT`, milestone 4)
only when it parsed and validated as the current `schemaVersion` (an integer equal to the
supported version). Everything else is served with `houseReadOnly: true` and the problem says
why: a newer version (`house_newer_version`), a non-integer, boolean, missing or < 1
`schemaVersion`, unreadable or invalid JSON, or a failed validation (`house_invalid`). Semantic
issues (§2.1) don't make it read-only: a `PUT` replaces the file with a fully validated layout.
A missing `house.json` is not read-only (there is nothing to protect; first run creates it).

- Migrations are ordered pure functions `dict → dict` in
  `apps/api/src/housebook/migrations/house/`, registered as `from_version → function`. They run
  when the file is read; the upgraded file is written on the next save (milestone 4, which
  also copies the original to `.housebook/history/`).
- The frontend only ever sees the current version.
- A file with a **newer** `schemaVersion` than the image supports (after a rollback) is
  **read-only**, decided from `schemaVersion` alone before any other validation. It is then
  loaded leniently (unknown keys dropped); if even that fails, the last valid layout (or none)
  is served, still read-only, with a `house_invalid` problem. It is never written:
  `X-Housebook-Read-Only: true` on `GET /api/house`, `houseReadOnly: true` in the snapshot,
  and a `house_newer_version` problem.

## 3. Item notes (Markdown + frontmatter)

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
check_every: 1y
manual: https://www.bosch-home.gr/
support: https://www.bosch-home.gr/
critical: false
attachments: ["[[Dishwasher/manual.pdf]]"]
tags: [housebook]
---

## Quick help
- **E15**: water in the base. Unplug, tilt back, dry, check hoses

## Maintenance log
- 2026-09-15 Technician replaced the drain pump (85 €)
```

### 3.1 Parsing

1. Decode UTF-8 (a BOM is tolerated); normalise CRLF/CR to LF.
2. Frontmatter starts with `---` on the **first** line and ends with the next `---` (or `...`)
   line. An opening `---` without a closing line is a **parse error** (usually a half-written
   file). No opening `---` means "no frontmatter": the file is not an item.
3. YAML is read with **every scalar as a string** (PyYAML `BaseLoader`): `serial: 0123` stays
   `"0123"`, `model: no` stays `"no"`, dates stay strings. Lists and mappings stay lists and
   mappings of strings. The top level must be a mapping.
4. Known keys are then typed (below). **A bad value drops only that field** and reports
   `note_invalid_field`; the item stays on the plan.
5. **Unknown keys are preserved** (`aliases`, `cssclasses`, anything else) and returned in
   `frontmatter`. Writes (milestone 4) keep them and keep the original formatting
   (minimal-diff writes).
6. The body is everything after the closing line, verbatim (after newline normalisation).

Limits (a note breaking one is a `note_parse_error`): file ≤ 4 MiB, frontmatter ≤ 64 KiB,
nesting ≤ 32 levels, ≤ 10 000 values. YAML **aliases** (`*name`) are rejected: they are how a
few hundred bytes expand into megabytes ("billion laughs"), and Obsidian never writes them.
Anchors without aliases are harmless and allowed. `house.json` is limited to 16 MiB, and
nesting that the JSON parser can't handle is a `house_invalid` problem.

When a known note fails to parse (or becomes empty mid-save), the index keeps the last good
version flagged `stale: true` with `parseError`, and reports `note_parse_error`. When it can't
be read at all (permissions, I/O), the same happens with a `read_error` problem; a folder that
can't be listed is reported as `read_error` too, and the notes it contained keep their last good
versions. A new file that fails to parse is only reported.

### 3.2 Known keys

| Key | Type after parsing | Notes |
|---|---|---|
| `housebook_id` | id | `^[A-Za-z0-9_-]{1,64}$`. Invalid → `note_invalid_id`, note ignored |
| `type` | string | Catalogue key or alias (case-insensitive). Unknown → generic box + `unknown_type`. Missing → generic box |
| `name` | string | Display name; falls back to the file name |
| `brand`, `model`, `serial` | string | |
| `purchased`, `warranty_until`, `next_check` | date | `YYYY-MM-DD`; a datetime prefix (`2024-05-10T…`) is accepted |
| `check_every` | interval | `<n><unit>`, unit `d`/`w`/`m`/`y` (case-insensitive), `n ≥ 1`: `10d`, `2w`, `6m`, `1y` |
| `manual`, `support` | URL | Scheme must be `http`, `https`, `mailto`, `tel` or `obsidian`; others are dropped (`javascript:` never becomes a link) |
| `critical` | bool | `true/false/yes/no/on/off/1/0`. Overrides the catalogue default (emergency sheet) |
| `attachments` | list of links | See §3.4 |
| `tags` / `tag` | list | See §3.3 |

Empty values (`key:` with nothing) are "not set". For dates, intervals and booleans `~` and
`null` also mean "not set". Frontmatter has **no version key**; changes are additive only.

### 3.3 Identity, tags, adoption

- `house.json` references items only by `housebook_id`. Paths don't matter: renaming or moving
  a note inside the notes folder keeps the link.
- Only `*.md` files **inside the notes folder** are considered. The notes folder must be a
  subfolder of the data root (`HOUSEBOOK_NOTES_DIR=.` is rejected at startup). Notes elsewhere in the vault are
  never read as items and never touched.
- The housebook tag is accepted in every form Obsidian writes: `tags: housebook`,
  `tags: [housebook]`, a block list, `#housebook`, comma- or space-separated strings, the
  singular `tag:` key, any case, and nested tags (`housebook/kitchen`).
- A tagged note **without** `housebook_id` is *adoptable*. It is reported as `not_adopted`
  (info). Milestone 4 writes the id when the user first opens or places it; there is never a
  startup sweep that writes ids.
- A note with a catalogue `type` but no tag and no id is reported as `untagged_typed` (info) and
  otherwise ignored.
- **Duplicate ids** (Obsidian "duplicate note", sync conflict copies): the canonical file is
  (1) the path already in the index, else (2) a file whose name is not a conflict copy, else
  (3) the oldest mtime (then the path). Others are reported as `duplicate_id` or
  `conflict_copy` with `detail.canonical`; nothing is rewritten automatically.
- **Conflict copies** are recognised by name: Syncthing `*.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.*`,
  Nextcloud/Dropbox/Obsidian Sync `* (conflicted copy …)`. A conflict copy that is the only
  file for its id is still indexed, with a `conflict_copy` warning.

### 3.4 Attachments

An item's attachments are the union of:

1. links listed in `attachments`: wikilinks `"[[Dishwasher/manual.pdf]]"`, with optional alias
   `"[[x.pdf|Manual]]"` or embed `"![[x.pdf]]"`, or plain paths. An unquoted
   `attachments: [[x.pdf]]` (which YAML reads as a nested list) is accepted too;
2. files directly inside the sibling folder named after the note (`Kitchen/Dishwasher/`),
   excluding `*.md` and dot-files.

A link resolves, in order: relative to the note's folder, relative to the data root, then a
unique file-name match anywhere under the data root (close to Obsidian's shortest-path rule).
A link that lands on a symlink escaping the root, by path or by file name, is unsafe.
All comparisons use **NFC** (macOS/iOS produce NFD names). Links that escape the root, or hit a
symlink that does, are reported as `attachment_unsafe`; unresolved links as
`attachment_missing`. Each attachment is served under its NFC file name; if two differ only in
folder, the first wins and `attachment_name_collision` is reported.

Serving: the content type comes from the file's **first bytes**, never its extension. Sniffed
PDF, PNG, JPEG, GIF and WebP are shown inline; HEIC/HEIF and everything else is a download
(`application/octet-stream` unless sniffed, `text/plain` for `.txt`/`.md`). All responses carry
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`,
PDFs included. The web app renders PDFs itself with PDF.js (it fetches the bytes, with Range
requests), so it doesn't depend on the browser's built-in viewer, which refuses sandboxed
documents. Opening an attachment URL directly in a browser tab may therefore show nothing;
download it instead. Attachments are never gzip-compressed and keep a strong ETag for `If-Range`.

### 3.5 Body conventions

- **Error codes:** bold text at the very start of a list item under a heading titled
  "Quick help" (any level, case-insensitive), up to the next heading of the same or higher
  level. `- **E15**: …` → `E15` (a trailing `:` inside the bold is dropped). Bold text later in
  the line is not a code.
- **Maintenance log:** list items starting with a date, `- YYYY-MM-DD text`, under a heading
  titled "Maintenance log". The latest date is the item's *last service*.

## 4. Status

Computed on read, never stored, against **today in `HOUSEBOOK_TZ`** (default `TZ`, else UTC).
`days = date − today`.

- **Next check.** `next_check` if set. Otherwise, if `check_every` is set: last service
  (§3.5) + interval, else `purchased` + interval (`derived: true`). Month and year steps clamp
  to the month end (31 Jan + 1m = 28/29 Feb).
  - `days < 0` → `overdue`
  - `0 ≤ days ≤ 30` → `due_soon`
  - otherwise `scheduled`
- **Warranty** (`warranty_until`):
  - `days < 0` → `expired` (neutral, no badge)
  - `0 ≤ days ≤ 60` → `ending`
  - otherwise `active`
- **Level** (the badge): `overdue` > `due_soon` > `warranty_ending`, else `null`.

```json
{ "level": "due_soon",
  "check":    { "state": "due_soon", "date": "2026-11-20", "days": 16, "derived": false },
  "warranty": { "state": "ending",   "date": "2026-12-01", "days": 27 } }
```

`GET /api/items?due=N` returns items whose check is due within N days (overdue included) or
whose warranty ends within N days (expired excluded), soonest first.

## 5. Search

Shared by `GET /api/items?q=` and the client-side search over the snapshot.

- **Fold:** NFD → remove combining marks → `lower()` → `ς` → `σ` → NFC. (`lower`, not
  `casefold`, so JS `toLowerCase()` matches exactly.) `ψυγείο` = `ΨΥΓΕΙΟ` = `ψυγειο`.
- **Compact form:** folded, with whitespace and `- _ . /` removed. Used for model, serial and
  error codes, so `FD041200123` matches `FD 0412 00123`.
- Query → folded, split on whitespace. An empty or whitespace-only query → no results
  (`GET /api/items` without `q` lists everything). **Every token must match**
  as a substring of some field (folded, or compact for the fields above).
- Tiers (lower is better): 1 name · 2 error code · 3 model, brand, serial · 4 catalogue type
  label, room name · 5 body. A token scores the best tier it hits; an item's score is the sum.
- Order: score; then items whose folded name starts with the folded query; then folded name;
  then id.

## 6. Catalogue (`contract/catalog.json`)

```json
{ "key": "washer", "label": "Washer", "defaultName": "Washing machine",
  "footprint": [1, 1], "mount": "floor", "critical": false, "aliases": ["washing_machine"] }
```

- `key` (`^[a-z][a-z0-9_]{0,39}$`) is a public contract: **never rename a key**; add an alias.
  Keys and aliases are unique, case-insensitive.
- `mount` ∈ `floor | wall | ceiling` decides the model height (wall items: back against the
  edge from §2.2). `critical` marks items for the emergency sheet (water/gas valve, fuse box,
  boiler, router), overridable per note.
- 3D model paths and note templates are added in milestones 3 and 6.

## 7. Problems (`GET /api/problems`)

`{ kind, severity, message, path?, itemId?, detail? }`, sorted by severity then path. Every fix
is an explicit user action; nothing is repaired silently.

| kind | severity | meaning |
|---|---|---|
| `house_missing` | error | no `house.json` |
| `house_invalid` | error | unusable `house.json`, read-only (last valid kept); `detail.reason` |
| `house_newer_version` | warning | read-only, see §2.3; `detail.reason` |
| `house_duplicate_id`, `house_bad_cell`, `house_outside_grid`, `house_unknown_room`, `house_unknown_floor`, `house_duplicate_placement` | warning | semantic rule broken (§2.1) |
| `note_parse_error` | error | note that can't be parsed or breaks a limit (last good kept if known) |
| `read_error` | error | note or folder that can't be read (last good kept) |
| `note_invalid_id` | error | bad `housebook_id`; note ignored |
| `note_invalid_field` | warning | one field dropped; `detail.key` |
| `duplicate_id`, `conflict_copy` | warning | §3.3; `detail.canonical` |
| `unknown_type` | warning | type not in the catalogue |
| `missing_note` | warning | placement without a note (ghost model in the UI) |
| `attachment_missing`, `attachment_unsafe`, `attachment_name_collision` | warning | §3.4 |
| `symlink_outside_root` | warning | ignored symlink |
| `not_adopted`, `untagged_typed` | info | §3.3 |

*Unplaced items* (note without placement) are a normal state, not a problem.

### 7.1 Why `house.json` is unusable: `detail.reason`

Every `house_invalid` and `house_newer_version` problem carries `detail.reason`, one value of
a closed set (`HouseProblemReason` in the OpenAPI spec). Clients **must switch on
`detail.reason`, never on `message`**: messages are prose for humans, change without notice,
and embed user content (a validation message names the offending key, so an unknown key
`unreadableNote` would make an `invalid` file read like an unreadable one).

| `reason` | emitted when | the owner fixes it by |
|---|---|---|
| `unreadable` | the file can't be read: permissions, I/O error, a directory instead of a file, a symlink leaving the data root | fixing permissions / the file system |
| `too_large` | the file is larger than 16 MiB (refused before parsing) | shrinking the file |
| `not_json` | not decodable as UTF-8 JSON (truncated, empty, bad encoding, nested too deeply to parse) | repairing the file |
| `bad_version` | `schemaVersion` missing, not an integer ≥ 1 (`"1"`, `1.0`, `true`), the root isn't a JSON object, or an older version this image has no migration for | fixing `schemaVersion` |
| `newer_version` | `schemaVersion` newer than this image supports: on `house_newer_version`, and on the `house_invalid` that accompanies it when the newer layout can't be displayed | upgrading the image |
| `invalid` | JSON with a supported `schemaVersion` that fails structural validation (unknown key, wrong type, out-of-range value, …) | editing the file |

Rules: `detail` may carry other keys besides `reason`, so read the key, don't compare the
object. A client that meets a `reason` it doesn't know treats it as `invalid`; new values are
added only with a contract update. When both kinds are present, `house_newer_version` is the
primary cause.
