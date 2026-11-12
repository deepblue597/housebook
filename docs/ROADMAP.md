# Roadmap

Milestones 0–5 are done: the data contract, the read-only app (2D, 3D, list, search, details),
writes with live sync, and the layout editor (rooms, items, resize, undo). This file lists what
comes next, most important first. It replaces the remaining rows of the milestone table in
`DESIGN.md` §12 and §15.20.

**How the order was chosen:** first what every household needs to use the app without a text
editor (M6), then what makes the plan fit real houses (M7), then the stated goal the app doesn't
meet yet, "what needs attention" (M8). The home-like look (M9) follows, since it builds on the
layout work of M7. Login (M10) comes before Paperless (M11) because linked receipts make the data
more sensitive. Sizes are rough working days for one developer.

Each milestone becomes a GitHub milestone, and each bullet an issue. Milestones without a
dependency between them can run in parallel (see the end).

---

## M6: Edit items in the app (~4–5 days) — done

Shipped in pull requests #2 (note editor), #3 (delete item), #4 (attachments) and #6 (first
run); decisions D31–D34.

Today an item's fields and text can only be changed by editing its `.md` file. The backend
already supports it (`PATCH /api/items/{id}`, `DELETE /api/items/{id}`); the app doesn't use it.

- **Note editor** in the item panel (editors only):
  - a form for the common fields: name, type, brand, model, serial, purchase date, warranty end,
    next check, check interval, manual and support links;
  - a Markdown editor for the body, with preview;
  - saving uses the note's ETag; when the note changed elsewhere meanwhile (Obsidian), show both
    versions instead of overwriting either.
- **Delete item:** confirmation, then the note and its attachment folder go to
  `.housebook/trash/` (recoverable for 90 days, already purged automatically). The placement goes too.
- **Upload attachments** (manuals, receipts, photos) and remove them:
  - PDF, JPEG, PNG, WebP, HEIC; type checked from the file content, not the name (DESIGN 15.13);
  - HEIC converted to JPEG, location (GPS) data stripped from photos;
  - size limit in the app; document the reverse-proxy limit (nginx defaults to 1 MB).
- **First run:** on an empty data folder, create `house.json`, the notes folder and one floor,
  and open the editor with a short "draw your first room" hint. Check what already works
  (`PUT /api/house` with `If-None-Match: *`) before building.

## M7: Floors, doors and windows (~3 days) — done

Shipped in pull requests #8 (floors) and #9 (doors and windows); decisions D35–D36.

The file format supports any number of floors and doors/windows; the editor can't create them.

- **Floor editing:** add (above the top floor or below the lowest), rename, move up/down,
  delete (an empty floor at once; otherwise a confirmation listing what goes, items to the
  Unplaced tray). Undo for all of it. New decision row D31.
- **Outline of the floor below** shown faintly while editing a floor (display only).
- **Door and window tool:** click a wall edge to add or remove a door or window. They're stored
  (`openings`) and drawn in 2D and 3D already.

## M8: What needs attention (~2–3 days)

Goal G5 ("surface what needs attention") is only met by badges on the plan today.

- **Attention list:** one page with what's overdue, due soon and whose warranty ends soon,
  sorted by date, each linking to the item. Status rules already exist on both sides.
- **After a maintenance log entry**, offer to set the next check from the item's interval
  (`check_every`), so `next_check` doesn't go stale after the first service.
- **Calendar feed** (`/api/calendar.ics`) of checks and warranty ends, behind a per-user token
  that can be revoked, since calendar apps can't log in (DESIGN 15.8).

## M9: Floor and wall finishes, a home-like view (~5–7 days)

Today rooms are flat colours, which is good for finding things but doesn't look like a home.
This adds a second way to look at the house.

- **View switch:** "Plan colours" (today's view) or "Home look", in both 2D and 3D. A per-person
  setting, remembered in the browser; it changes nothing in the data.
- **Floor finish per room:** pick from a built-in set: wood (light oak, oak, walnut,
  herringbone), tiles (white, grey large-format, terracotta, black and white checker), stone,
  concrete, carpet. Shown as textures in 3D and as patterns in 2D.
- **Wall finish per room:** a paint colour (a preset palette plus any colour) or a wallpaper from
  a built-in set. A wall between two rooms shows each room's finish on its own side; outside walls
  get one colour for the whole house.
- **Your own wallpapers and floors:** upload an image (JPEG, PNG or WebP; uses the upload code of
  M6) with its real-world size, e.g. "this pattern repeats every 50 cm". Stored as files in the
  data folder (`Textures/`), so they are backed up with everything else.
- **Editing:** in the layout editor's room list, a "Finish" button per room opens swatches for
  floor and walls. Undo works as for any other edit; "copy finish to other rooms" for whole
  apartments done in one floor.
- **3D lighting:** the "Home look" uses lit materials and soft lighting (today's 3D view is
  unlit), and stays fast on phones: small textures (512 px, loaded only when the home look is
  on), one material per finish.

What it takes underneath:

- **`house.json` version 2.** The file rejects unknown keys, so finishes need a new schema
  version: `rooms[]` gets optional `floor` and `walls`, the house gets `exteriorWallColor`.
  Version 1 files are upgraded automatically on the first save (the `migrations/` folder exists);
  an older image opens a version 2 file read-only instead of breaking it (DESIGN 15.4).
- **Built-in textures** from CC0 libraries (ambientCG, Poly Haven), credited in the repo; a
  catalogue of finishes in `contract/` like the item catalogue, so backend and frontend agree on
  the names.
- Rooms are shared by all floors, so a room's finish is the same on every floor it appears on.
  Per-floor finishes would wait for a later version.

## M10: Login (~2–3 days)

Today: no login (`none`), or a login service in front of the app (`proxy`).

- **`oidc` mode:** the app sends people to the household's login provider (Keycloak, Authentik,
  Authelia) itself, so no extra proxy is needed. Provider groups map to viewer/editor as in
  `proxy` mode.
- **Show who is logged in**, with a log-out link, in both login modes.
- **Setup guide** for each mode, including the simple one (one person, home network or
  Tailscale) and why it must not be exposed to the internet.

## M11: Paperless receipts (~2–4 days)

Link receipts and invoices stored in Paperless-ngx to items.

- **Settings:** `HOUSEBOOK_PAPERLESS_URL`, `HOUSEBOOK_PAPERLESS_TOKEN` (also readable from a
  file, for Docker secrets). Only the backend uses the token.
- **Link format:** the document's Paperless URL in the note, e.g.
  `receipts: ["https://paperless.home/documents/1234/details"]`. Readable and clickable in
  Obsidian too.
- **"Link receipt"** in the item panel: search Paperless, pick with thumbnails, saved to the note.
- **Previews** through the backend, only for documents linked from that item (never an open
  door into all of Paperless).
- **When Paperless is down** a plain link is shown; a deleted document is reported in the
  problems panel (`paperless_missing`).

## M12: Emergencies and offline (~3–4 days)

"Where is the main water valve?" has to work when the internet, the server or the login doesn't.

- **Printable emergency sheet** (`/print/emergency`): the plan of each floor with the critical
  items (water valve, fuse box, gas valve, boiler, router, or `critical: true`), their location
  and quick help. The attention list reminds you to reprint when it's out of date. (Done: D44.)
- **QR stickers:** print sheets of QR codes linking to `/i/<item id>` (the route exists).
- **Offline viewing (PWA):** the app and last known data stay readable without a connection,
  with an "Offline, data from <time>" banner. Editing stays online only.

## M13: Releases and operations (~2 days)

- **Publish the Docker image** to GitHub's container registry on version tags, with a changelog.
- **Export** (`/api/export`, editors only): a zip of the data folder, streamed.
- **Backup and restore guide** (what to back up, how to test a restore).
- **Dependency updates:** Dependabot (or Renovate) for GitHub Actions, Python and npm packages.

---

## Later (not scheduled)

- Paperless, phase 2: tag documents in Paperless to link them from that side; fill in purchase
  date and warranty from the document.
- 3D view with all floors stacked; stairs that connect floors.
- Different grid sizes per floor (needs a new `house.json` version).
- Push or email reminders (beyond the calendar feed).
- Public, revocable share links for single items (DESIGN 15.13).
- Built-in username/password login, only if non-technical households become a target.
- Translations of the interface (strings are already in one place).
- Home Assistant integration.

## What can run in parallel

| Track | Milestones | Main code areas |
|---|---|---|
| Items | M6 → M11 | `features/details`, backend writer and attachments |
| Layout | M7 → M9 | `commands/`, `features/editor`, `features/plan2d`, `features/scene3d` |
| Attention | M8 → M12 | new pages, `domain/status`, a new backend route |
| Platform | M10, M13 | backend auth, CI, Docker |

M11 needs M6 (item panel editing) and should come after M10 (login). M9 needs M7 (it changes the
same editor) and, for your own textures, the uploads of M6. The rest are independent, so up to
four people can work without blocking each other.
