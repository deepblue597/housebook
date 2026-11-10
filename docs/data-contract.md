# Housebook data contract (v1)

This is the contract between the files on disk, the backend and the frontend. Machine-readable
parts live in [`/contract`](../contract):

| File | What |
|---|---|
| `contract/house.schema.json` | JSON Schema of `house.json` v2, generated from the Pydantic model (`uv run housebook schema --out ../../contract/house.schema.json`). A test fails if it is stale. |
| `contract/catalog.json` | Item type catalogue |
| `contract/finishes.json` | Floor and wall finishes and the paint palette (§6.1) |
| `contract/fixtures/status_cases.json` | Golden cases for status rules, "today" and `check_every` parsing |
| `contract/fixtures/search_cases.json` | Golden cases for folding, error-code extraction and search ranking |
| `contract/fixtures/house_validation_cases.json` | Layouts `PUT /api/house` rejects (with the expected error `type`/`loc`) or accepts (§2.1, §8.1), including `inherited` cases judged against a given file on disk (D30) |
| `contract/fixtures/frontmatter_write_cases.json` | How the server writes one frontmatter value: plain vs. quoted (§3.6) |

Backend (pytest) runs every fixture; the frontend (vitest) runs the status, search and placement
cases (`house_validation_cases.json` and `frontmatter_write_cases.json` are server-side only for now). If a rule changes, change the
fixture first.

## 1. Data root layout

```
<data root>/                 HOUSEBOOK_DATA_DIR
  house.json                 layout (written only by PUT /api/house)
  House/                     notes folder (HOUSEBOOK_NOTES_DIR); only *.md files here are items
    Kitchen/
      Dishwasher.md          one item
      Dishwasher/            sibling folder: attachments of Dishwasher.md
        manual.pdf
  .housebook/                app state, never synced as content
    lock                     single-process flock
    history/                 previous house.json versions: house-<UTC stamp>.json, last 50 kept
    trash/                   deleted notes: <UTC stamp>-<id>/, purged after 90 days (at startup)
    calendar-links.json      calendar link fingerprints, one per person (§10)
```

Ignored everywhere: dot-files and dot-dirs (`.housebook`, `.obsidian`, `.trash`, `.stversions`,
`.syncthing.*.tmp`, …), `*.tmp`, `*.swp`, `*~`, `4913`, `~syncthing~*`, `*.crdownload`, `*.part`.
Symlinks are followed only if they resolve inside the data root; others are ignored and
reported (`symlink_outside_root`).

## 2. `house.json` v2

```json
{
  "$schema": "../../contract/house.schema.json",
  "schemaVersion": 2,
  "grid": { "tileSize": 1.0, "width": 16, "depth": 10 },
  "exteriorWallColor": "#E6E1D8",
  "rooms":  [ { "id": "rm_kit", "name": "Kitchen", "color": "#E3A94B",
                "floor": "tiles_white", "walls": "#B7C2A6" } ],
  "floors": [ { "id": "fl_0", "name": "Apartment", "level": 0, "cells": { "7,1": "rm_kit" } } ],
  "placements": [ { "itemId": "it_7f3k2a", "floorId": "fl_0", "x": 10, "y": 2, "rotation": 90 } ],
  "openings":   [ { "floorId": "fl_0", "x": 8, "y": 5, "side": "n", "kind": "door" } ]
}
```

| Field | Type | Rules |
|---|---|---|
| `$schema` | string, optional | Kept as is. Points editors (VS Code) at the JSON Schema |
| `schemaVersion` | integer | `2`. See §2.3 |
| `grid.tileSize` | number, metres | `0 < tileSize ≤ 10`, default 1 |
| `grid.width`, `grid.depth` | integer | 1–512 tiles along x / y |
| `exteriorWallColor` | string, optional | `#RRGGBB`: the outside walls of the whole house in the home look (default from §6.1) |
| `rooms[]` | `{id, name, color, floor?, walls?}` | Global, shared by all floors. `color` is `#RRGGBB` (the plan colour). `floor`: a floor finish key (§6.1). `walls`: a paint `#RRGGBB` or a wallpaper key (§6.1). Keys match `^[a-z][a-z0-9_]{0,39}$`; an unknown key is a `house_unknown_finish` warning, drawn as if unset. A room has the same finish on every floor it is on |
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

`PUT /api/house` rejects a layout that breaks a structural rule, or breaks a semantic rule
more than the file on disk already does, with `422` (§8.1). A hand-edited
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

**Writable only when current and valid.** `house.json` may be written (by `PUT`)
only when it parsed and validated as the current `schemaVersion` (an integer equal to the
supported version). Everything else is served with `houseReadOnly: true` and the problem says
why: a newer version (`house_newer_version`), a non-integer, boolean, missing or < 1
`schemaVersion`, unreadable or invalid JSON, or a failed validation (`house_invalid`). Semantic
issues (§2.1) don't make it read-only: a `PUT` replaces the file with a fully validated layout.
A missing `house.json` is not read-only (there is nothing to protect; first run creates it).

- Migrations are ordered pure functions `dict → dict` in
  `apps/api/src/housebook/migrations/house/`, registered as `from_version → function`. They run
  when the file is read; the upgraded file is written on the next save, which first copies the
  original to `.housebook/history/house.v<n>.<stamp>.json` (never rotated).
- v1 → v2 (D41) only adds the optional finish keys: the step sets `schemaVersion: 2`.
- The frontend only ever sees the current version. A `PUT` with an older `schemaVersion` (a
  browser still running the previous app after an upgrade) is upgraded the same way before it is
  validated; a newer one is a `422`.
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
   `frontmatter`. Writes keep them and keep the original formatting (minimal-diff writes, §3.6).
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
  (info). The client adopts it (`POST /api/items/adopt`, §8.2) when the user first opens or
  places it; there is never a startup sweep that writes ids.
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

### 3.6 How the server writes notes

Only the item endpoints (§8.2) write notes; they never touch `house.json` (D8).

- **Minimal diff.** Only the lines of keys whose value changed are rewritten, removed or appended
  (new keys go after the last one). Comments, key order, blank lines, unknown keys and their
  formatting stay byte-identical. A replaced value keeps its trailing `# comment`, its quote
  style (`'…'` / `"…"`) and block-list style (`tags:\n  - a`). The BOM and CRLF line endings of
  the file are kept. Duplicate keys collapse into the first. Every result is parsed again and must
  read back exactly as intended; if line edits can't achieve that (e.g. a flow mapping as the
  whole frontmatter) the frontmatter is rendered from scratch, and if even that fails the write
  is refused (`422`).
- **Quoting.** A string is written plain only if every YAML reader (PyYAML's YAML 1.1 resolver,
  Obsidian's YAML 1.2) reads it back as the same string; otherwise it is double-quoted:
  `serial: "0123"`, `model: "no"`, `name: "on"`, `brand: "1e3"`, `name: "Note: big"`,
  `manual: "[[x.pdf]]"`. On purpose plain: `YYYY-MM-DD` under `purchased`, `warranty_until`,
  `next_check`, and `true`/`false` under `critical` (how Obsidian types those properties). JSON
  booleans and numbers sent by a client are written plain (`rating: 5`). Lists are written in flow
  style (`[a, "b c"]`) unless the key already had a block list. See
  `contract/fixtures/frontmatter_write_cases.json`.
- **Atomic.** Write to a dot-prefixed temp file in the same folder, fsync, rename, fsync the
  folder. The file's permission bits are kept; a symlink inside the data root is written through,
  not replaced.
- **New notes** go to `<notes>/<Room>/<Name>.md` (DESIGN 8.4). File names are NFC, without path
  separators, control characters or `<>:"|?*`, without leading dots or trailing dots/spaces, at most
  120 UTF-8 bytes, never a Windows device name (`CON`, `NUL`, …) or an ignored pattern (fallback
  `Item`). On a collision (case-insensitive; an existing `<Name>/` folder counts too, so a new note
  never inherits someone else's attachments) `-2`, `-3`, … is appended. `name` in the frontmatter
  keeps the original text.
- **Maintenance log.** `POST /api/items/{id}/log` inserts `- YYYY-MM-DD text` after the last
  non-blank line of the first "Maintenance log" section (any heading level, case-insensitive, up
  to the next heading of the same or a higher level), or appends `## Maintenance log` at the end of
  the body. The text is one line (whitespace collapsed).

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

### 6.1 Finishes (`contract/finishes.json`, D41)

```json
{ "floors":     [ { "key": "oak", "label": "Oak", "group": "Wood", "color": "#9b7b5d",
                    "texture": "oak.jpg", "size": [1.8, 1.8] } ],
  "wallpapers": [ { "key": "stripes", "label": "Stripes", "color": "#dce2e6",
                    "texture": "wallpaper-stripes.jpg", "size": [0.5, 0.5] } ],
  "paints":     [ { "label": "Sage", "color": "#b7c2a6" } ],
  "exteriorDefault": "#e6e1d8" }
```

- `floors[].key` and `wallpapers[].key` are what `rooms[].floor` and `rooms[].walls` store: a
  public contract like item type keys, **never renamed**. `texture` is a file in
  `apps/web/src/assets/textures/` (credits and how they are built in its `LICENSES.md`, D42) and
  `size` the metres `[x, y]` it covers before it repeats. `color` is the texture's average colour,
  drawn while the texture loads or if it fails. `paints` is the preset palette
  (any `#RRGGBB` is allowed in `walls`); `exteriorDefault` colours the outside walls when the
  house has no `exteriorWallColor`.
- Finishes are a second way to look at the house ("Home look", a per-browser setting); the plan
  colours stay the default. A room without a floor finish keeps its plan colour; walls without a
  finish are drawn in the first paint (white). Each side of a wall shows the finish of the room on
  that side; sides facing no room use the outside colour.

## 7. Problems (`GET /api/problems`)

`{ kind, severity, message, path?, itemId?, detail? }`, sorted by severity then path. Every fix
is an explicit user action; nothing is repaired silently.

| kind | severity | meaning |
|---|---|---|
| `house_missing` | error | no `house.json` |
| `house_invalid` | error | unusable `house.json`, read-only (last valid kept); `detail.reason` |
| `house_newer_version` | warning | read-only, see §2.3; `detail.reason` |
| `house_duplicate_id`, `house_bad_cell`, `house_outside_grid`, `house_unknown_room`, `house_unknown_floor`, `house_duplicate_placement` | warning | semantic rule broken (§2.1) |
| `house_unknown_finish` | warning | a room's `floor` or `walls` names a finish not in `contract/finishes.json` (§6.1); never blocks a `PUT` |
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

## 8. Write API

All writes need the `editor` role (`403` otherwise, checked before the body is read; the one
exception is a person's own calendar link, §10, which any signed-in role may make) and, when they have a body,
`Content-Type: application/json` (`application/merge-patch+json` is accepted too; anything else is
`415`: a cross-site form or no-cors fetch can't send it, which is the CSRF guard). One write runs at
a time (single process, D10). After every write the index is rescanned, so the response and the
next `GET` already show the change, and other clients get an event (§9).

**Preconditions.** `If-Match` carries the ETag the client last read (from the `ETag` header, or the
`etag` / `houseEtag` field of the snapshot; quoted, unquoted and `W/` forms are all accepted). It is
compared with the hash of the file **on disk**, not the index, so a save in Obsidian that the
watcher hasn't seen yet still makes a stale ETag fail. `If-Match: *` means "overwrite whatever is
there" (the UI's *overwrite* after a conflict); for `PUT /api/house` the new layout is still judged
against the file on disk (§8.1).

| Status | When | Body |
|---|---|---|
| `412` | ETag doesn't match the file on disk (the index is refreshed before answering, so a reload gets the new version) | `{"detail": "...", "currentEtag": "<etag or null>"}`, header `ETag` |
| `428` | `If-Match` missing where required | `{"detail": "..."}` |
| `409` | the target can't be written safely | `{"detail": "...", "reason": "..."}` (reasons below) |
| `413` | request body over 17 MiB (`PUT /api/house`) or 25 MiB (other writes), refused before parsing (by `Content-Length`, or while streaming a chunked body); `house.json` > 16 MiB; a note would exceed 4 MiB of UTF-8 or its frontmatter 64 KiB | `{"detail": "..."}` |
| `415` | body without a JSON content type | `{"detail": "..."}` |
| `422` | validation | `{"detail": [{"type", "loc", "msg"}]}`, same shape as FastAPI's request validation; `loc` starts with `"body"`. `input` is included only when it is short (never a large body echoed back) |

`409` reasons: `newer_version`, `invalid`, `unreadable`, `not_json`, `bad_version`, `too_large`
(house.json is read-only, §2.3; the value is the `detail.reason` of the house problem),
`unparseable` (the note's frontmatter can't be parsed: fix it in an editor first), `id_changed`,
`exists`, `not_tagged`, `has_id`.

### 8.1 `PUT /api/house`

Body: the whole layout, as `GET /api/house` returns it. `If-Match` or `If-None-Match` is required
(`428` without either), evaluated in RFC 9110 order: `If-Match` first, then `If-None-Match`, which
fails (`412`) when it is `*` and the file exists, or lists the current ETag. To create a missing
`house.json` send `If-None-Match: *`. A read-only `house.json` (§2.3) is never written (`409`).

Validation (D30: a save may not make the layout worse than the file on disk; it doesn't have to
make it perfect):

- **Structure** (Pydantic: types, ranges, patterns, unknown keys) is always enforced, right
  after the role, size and content-type checks (`403`, `413`, `415`) and before the preconditions.
- **`house_bad_cell`** (a cell key that isn't canonical `x,y`) is always rejected: the server
  normalises such keys when it reads a file, so a client never needs to send one.
- **The other semantic rules of §2.1** are compared with the file **on disk** (also for
  `If-Match: *`; with no file, e.g. `If-None-Match: *`, every issue counts as new). Each issue has
  a subject without list indexes or coordinates: unknown room → (floor, room id); duplicate
  placement → item id; placement outside the grid or on an unknown floor → item id; cells outside
  the grid → floor; openings outside the grid or on an unknown floor → floor (counted apart from
  cells); duplicate id → (room or floor, id).
  The request is rejected when a `(type, subject)` pair occurs more often than in the file on disk.
  So problems a hand-edit left behind may stay, move (a resize or a move shifts coordinates) or go
  away, but one more tile of a missing room, a third copy of a placement, or a new kind of problem
  is refused.

A `422` lists only the offending issues (every issue of a subject that got worse), each
separately, e.g.
`{"type": "house_unknown_room", "loc": ["body", "floors", 0, "cells", "1,0"], "msg": "..."}`
(semantic `type`s are the `house_*` problem kinds). Order of checks: `403`, `413`, `415`,
structural `422`, `409 unreadable` (house.json exists but can't be read, so the preconditions
can't be judged), `428`, `412`, `409` read-only, then the semantic `422`, judged under the write
lock against the file the preconditions were checked on (if the file is replaced between that
check and the rescan, the answer is `412`). If the body omits `$schema`, the current file's `$schema` is kept. Before writing, the
previous file is copied to `.housebook/history/` (last 50 kept). Written in the deterministic form of
§2.1. An identical layout is a no-op (no write, no history entry). Response: `200`, the layout as
written, `ETag`.

### 8.2 Items

| Method | Path | Body | Precondition | Response |
|---|---|---|---|---|
| `POST` | `/api/items` | `{type, name?, roomId?, frontmatter?, body?}` | – | `201`, item detail, `ETag`, `Location` |
| `PATCH` | `/api/items/{id}` | `{frontmatter?, body?}` | `If-Match` | `200`, item detail, `ETag` |
| `POST` | `/api/items/{id}/log` | `{text, date?}` | none | `200`, item detail, `ETag` |
| `DELETE` | `/api/items/{id}` | – | `If-Match` | `204` |
| `POST` | `/api/items/{id}/attachments?name=` | the file (`application/octet-stream`) | none | `201`, item detail, `ETag`, `Location` (the file) |
| `DELETE` | `/api/items/{id}/attachments/{name}` | – | none | `200`, item detail, `ETag` |
| `POST` | `/api/items/adopt` | `{path}` | none | `200`, item detail, `ETag` |

- **Create:** `type` is a catalogue key or alias (stored as the canonical key); `name` defaults to
  the type's `defaultName`; `roomId` picks the folder (the room's name); `frontmatter` adds keys
  (`housebook_id`, `type`, `name` are not allowed there; `tags` defaults to `[housebook]`); `body`
  defaults to an empty template (Quick help / Maintenance log / Notes; real templates arrive in
  milestone 6). The new id is `it_` + 6 base36 characters. The layout is not touched: the client
  adds the placement with `PUT /api/house` afterwards (D8), so until then the item is unplaced.
- **Patch:** `frontmatter` is a JSON Merge Patch (RFC 7396) on the frontmatter: `null` deletes a key,
  objects merge, anything else replaces. `body` replaces the body verbatim when present (non-null).
  `housebook_id` can't change (`422`, `type: "read_only"`). Known keys the patch sets must be valid
  (`422` with `loc: ["body", "frontmatter", "<key>"]`); keys it doesn't touch are not checked.
- **Log:** `date` defaults to today in `HOUSEBOOK_TZ`. No `If-Match`: an append merges with whatever
  is on disk, so the most common household write never conflicts (D11).
- **Delete:** moves the note, and its sibling attachment folder unless that folder contains notes,
  to `.housebook/trash/<stamp>-<id>/`. Remove the placement first (D8); otherwise it becomes a
  `missing_note`.
- **Upload attachment (D33):** the body is the file itself with `Content-Type:
  application/octet-stream` (anything else is `415`; a cross-site form can't send it, the same
  CSRF guard as JSON); `name` is the original file name. At most 25 MiB (`413`); an empty body or
  a name with control characters is `422`. The type is taken from the first bytes: PDF, JPEG, PNG,
  WebP, HEIC/HEIF, anything else is `415`. PDFs are stored as sent. Images are decoded and saved
  again: EXIF orientation applied, all metadata (EXIF incl. GPS, XMP, comments) dropped, colour
  profile kept; HEIC/HEIF become JPEG; more than 80 megapixels or an unreadable image is `422`.
  The file goes into the item's attachments folder (`House/Kitchen/Dishwasher/`, created if
  needed) under the cleaned name (rules as for notes, fallback `Attachment`) with the extension of
  its type (`.pdf`, `.jpg`, `.png`, `.webp`), `-2`, `-3`, … on a collision, and
  `"[[Dishwasher/<file>]]"` is appended to `attachments` (minimal diff; an unquoted
  `[[x]]` entry is rewritten as `"[[x]]"`). No `If-Match`: like a log entry, it merges with
  whatever is on disk. A note that can't be parsed is `409 unparseable` and nothing is stored.
  Uploads in progress live in `.housebook/uploads/` and are deleted whatever happens.
- **Delete attachment (D33):** only a file directly in the item's attachments folder (else
  `409 not_in_folder`: a link elsewhere may be shared by several notes; remove the link in the note
  instead). The file moves to `.housebook/trash/<stamp>-<id>-attachment/`; links in `attachments`
  that point to it are removed (the key too when none is left).
- **Adopt:** `path` of a current `not_adopted` problem (anything else: `404`, or `422` outside the
  notes folder), so files the scanner ignores are never written. Writes a new `housebook_id` as the
  first frontmatter line (`409` `not_tagged` / `has_id` if the file changed since the scan).
- **Create** rejects names with control characters (`422`). File names never look like a sync
  conflict copy (`.sync-conflict-…`, `(conflicted copy …)` are neutralised), and an existing room
  folder is reused whatever its Unicode normalisation or case (an NFD `Κουζίνα/` from macOS is not
  shadowed by a second NFC one).
- **Paths** in item responses, events and problems are NFC (the file on disk may be NFD).

## 9. Events (`GET /api/events`)

Server-sent events (`text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, never
compressed). Same auth as the rest of `/api`; viewers may listen. There is no event log and no
`Last-Event-ID` replay: every (re)connect starts with `resync`, and the client refetches what
differs. A `ping` event (`data: {}`) is sent after every 20 s of silence: it keeps proxies from
timing out, and since `EventSource` hides comments, it is what a client watchdog listens for (no
event of any kind for ~45 s: close and reconnect, or fall back to polling). On server shutdown
every stream is ended at once; `EventSource` then reconnects by itself. A client that falls 64 events behind is
dropped (it reconnects and resyncs).

```
retry: 5000

event: resync
data: {"houseEtag":"…","houseReadOnly":false,"itemsVersion":"…","problemCount":0}

event: house.changed
data: {"etag":"…","readOnly":false}

event: item.changed
data: {"id":"it_7f3k2a","etag":"…","path":"House/Kitchen/Dishwasher.md","stale":false,"attachmentsEtag":"…"}

event: item.deleted
data: {"id":"it_7f3k2a"}

event: problems.changed
data: {"count":3}

event: ping
data: {}
```

| Event | Meaning | Client action |
|---|---|---|
| `resync` | sent first on every connection | compare `houseEtag` with the held house ETag and `itemsVersion` with the snapshot's `itemsVersion`; refetch `/api/snapshot` (with `If-None-Match`) if either differs |
| `house.changed` | `house.json` changed (`etag` null: missing/unreadable) | ignore if `etag` equals the held one; else `GET /api/house` |
| `item.changed` | a note was created, edited, renamed/moved (`path` changes), became unparseable or parseable again (`stale` changes; while stale, `etag` is the last good version's), or its attachment set changed (`attachmentsEtag` changes; the note's `etag` doesn't) | ignore only if `etag`, `path`, `stale` **and** `attachmentsEtag` all equal what is held (every item in `/api/snapshot` and `GET /api/items/{id}` carries them); else `GET /api/items/{id}` |
| `item.deleted` | the note is gone (after a 3 s grace period for external deletes, at once for `DELETE`) | drop it; a placement for it becomes a missing note |
| `problems.changed` | the integrity report changed | refetch `/api/problems` if the panel is shown |
| `ping` | nothing else happened for 20 s | reset the watchdog; nothing else |

- **Writes from the app are announced too** (other tabs and devices need them). The writer
  recognises its own change because the event's `etag` equals the one in its write response.
- **Echo suppression:** when the watcher later sees the app's own write, the file's hash equals the
  index's, so nothing is sent again.
- **Renames** (delete + create, as Obsidian and Syncthing do them) become one `item.changed` with
  the new `path`; `problems.changed` is held back during the grace period too, so a rename doesn't
  flash a missing note.
- **Half-written notes:** a note that just became unparseable is re-checked once after ~1 s before
  its `item.changed` (`stale: true`) and `problems.changed` are sent.
- `itemsVersion` is a hash over every item's id, etag, path, staleness and `attachmentsEtag`. It is
  also in `GET /api/snapshot`.
- `attachmentsEtag` is a 16-hex hash of the item's attachments (sorted name, size, mtime): it
  changes when a file is added, removed, replaced or resized. It is not a precondition for writes.
- **Errors:** `EventSource` can't see a `401` or a redirect to the login page. On `error`, call
  `GET /api/me`; on `401`, reload the page. After repeated errors fall back to polling
  `/api/snapshot` with `If-None-Match` (DESIGN 15.7).

## 10. Calendar feed (D40)

Calendar apps can't log in, so the feed is read with a private link instead of a session.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/calendar/link` | – | `200`, `{exists, createdAt, url: null}` for the caller |
| `POST` | `/api/calendar/link` | `{}` (JSON, §8) | `201`, `{exists: true, createdAt, url}`; the caller's old link stops working |
| `DELETE` | `/api/calendar/link` | – | `204` (also when there was none) |
| `GET` | `/api/calendar.ics?token=` | – | `200` `text/calendar; charset=utf-8`, `ETag` (`If-None-Match` → `304`); `404` for an unknown, replaced or missing code |

- **Links.** One per person: the `proxy` user name, or one shared by the household in `none` mode
  (key `""`). The three `/api/calendar/link` routes need a login like the rest of `/api` but any
  role. `url` is `<origin>/api/calendar.ics?token=<code>`, the code 43 random URL-safe characters;
  it is returned **only** by the `POST`. `.housebook/calendar-links.json` keeps
  `{version: 1, links: {<user>: {hash, createdAt, origin}}}`, `hash` = SHA-256 of the code (hex),
  `origin` = the request's `Origin` header (else its base URL), used for the item links in the feed.
  An unreadable file means no link works until a new one is made. Codes are replaced by
  `[redacted]` in the logs.
- **The feed** needs no login: the code is the key (with `proxy` auth, let this one path through
  the proxy). Per item, an all-day event on the next check date (explicit or derived, §4) and one
  on `warranty_until`, whatever their state (past dates stay in the past):
  `UID` `<item id>-check@housebook` / `<item id>-warranty@housebook` (stable, so a changed date
  moves the event), `SUMMARY` `Check: <name>` / `Warranty ends: <name>`, `DESCRIPTION` room · floor,
  brand and model, "Every <check_every>, …" for derived checks, and the item link; `URL` the item
  link (`<origin>/i/<id>`); `TRANSP:TRANSPARENT`. `DTSTAMP` is the time of the last scan.
  `X-WR-CALNAME:Housebook`, `REFRESH-INTERVAL` and `X-PUBLISHED-TTL` of 6 hours (a hint; Google
  refreshes on its own schedule). RFC 5545 text escaping, CRLF lines folded at 75 octets.
