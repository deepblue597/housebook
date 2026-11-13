# housebook-web

The Housebook SPA: the 2D floor plan, a lazy-loaded 3D view (milestone 2), a
Floor → Room → Item list, item and room details, client-side search, live sync and a problems
panel (milestone 4), maintenance log entries, the layout editor (milestone 5), and the note
editor (milestone 6). React +
TypeScript + Vite, Zustand for state; three.js via react-three-fiber (+ drei) for 3D.

## Run

Requires Node 24 and pnpm (version pinned in `package.json`), plus `uv` for the backend.

```sh
pnpm install

# backend on :8000 (from the repo root README)
cd ../api && HOUSEBOOK_DATA_DIR=../../examples/house HOUSEBOOK_TZ=Europe/Athens uv run housebook serve

# dev server on :5173, proxies /api to http://127.0.0.1:8000 (override with HOUSEBOOK_API)
pnpm dev
```

`pnpm build` writes `dist/`; the backend serves it with `HOUSEBOOK_STATIC_DIR=…/dist` (the Docker
image does this; see the root `Dockerfile`).

## Scripts

| Script                               | What                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                          | Unit and component tests (vitest + Testing Library, jsdom)                                                                                                                                                                                                                                                                     |
| `pnpm e2e`                           | Builds `dist-e2e/` (`vite build --mode e2e`: production build plus the `window.__housebook` test hook), starts the real backend on a temp copy of `examples/house` (port 8766, `E2E_PORT` to change) and runs Playwright (desktop + phone projects, axe, visual baseline). First time: `pnpm exec playwright install chromium` |
| `pnpm e2e:docker`                    | Opt-in: builds the image from the repo root (or uses `HOUSEBOOK_IMAGE`), runs it hardened on a temp copy of `examples/house` (port 8767) and runs the `@smoke` tests against it. Removes the container and copy afterwards                                                                                                     |
| `pnpm size`                          | After `pnpm build`: initial JS must be ≤ 200 KB gzipped (DESIGN 15.10). Lazy chunks (3D, Markdown, PDF.js) are listed but don't count. `ANALYZE=1 pnpm build` adds `dist/stats.html`                                                                                                                                           |
| `pnpm gen:api`                       | Regenerates `src/api/openapi.json` and `src/api/schema.gen.ts` from the FastAPI app object (no server needed)                                                                                                                                                                                                                  |
| `pnpm check:api`                     | Fails if the committed client differs from the backend's spec (CI contract check, DESIGN 15.15)                                                                                                                                                                                                                                |
| `pnpm typecheck` / `lint` / `format` | `tsc -b` (strict), ESLint (typescript-eslint, react-hooks, jsx-a11y), Prettier                                                                                                                                                                                                                                                 |
| `pnpm check`                         | All of the static checks plus unit tests                                                                                                                                                                                                                                                                                       |

## Layout (DESIGN §7.2)

```
src/
  domain/      pure TS, no React: text folding, search, status rules, dates, notes conventions
               (error codes, maintenance log), coordinates, walls/areas/labels, 3D geometry
               (item transforms, wall boxes with door/window cuts, merged mesh buffers, picking),
               colour contrast, URL allowlist, wikilinks, layout editing (layout.ts: rectangles,
               occupancy/stacking, rotate/move clamping, grid resize with shift and loss).
               ESLint forbids UI imports here.
  commands/    layout edits as plain-data commands: apply → new layout + exact inverse, or a
               conflict; replay of pending commands on a fresh layout (412). Pure (domain only).
  catalog/     item types from contract/catalog.json, type icons, type → 3D model (box sizes)
  api/         generated OpenAPI types + a small typed fetch client
  store/       Zustand: data (snapshot + ETag, single-item updates, writes, one ordered queue),
               sync (SSE client + polling fallback), ui (view, floor, selection, query, theme),
               editor (mode, tool, undo/redo history, pending edits, debounced save, replay),
               the derived read model (incl. missing-note ghosts), search results
  features/
    plan2d/    SVG plan, pan/zoom (mouse, wheel, touch pinch)
    scene3d/   lazy chunk: R3F scene, camera math (camera.ts, pure), layout, DOM overlays
    list/      list view with arrow-key navigation
    details/   item and room panel, Markdown notes (lazy), attachments, PDF.js viewer (lazy),
               note editor (noteForm.ts: pure rules; drafts.ts: unsaved edits per item)
    search/    search combobox
    problems/  ⚠ badge + lazy problems panel (GET /api/problems grouped by kind, Adopt)
    editor/    edit mode: tools as small state machines (tools.ts), pointer → tool forwarding
               shared by 2D and 3D (useToolPointer), previews, keyboard shortcuts, Edit toggle,
               messages, layout actions in the details panel; the side bar (rail, rooms,
               catalogue, Unplaced tray) and the resize/new-item dialogs are a lazy chunk
  app/         shell, router (/i/<id>), theme, 2D/3D toggle + lazy 3D loader, WebGL probe,
               test hook (non-production builds only)
  components/  shared UI bits (dialog, status wording)
  strings/     UI text by area (editor.ts), DESIGN D23
```

The shared contract is imported as `@contract/…` (`../../contract`).

## Behaviour notes

- **Data:** one `GET /api/snapshot` on load, then kept current by **live sync** (`store/sync.ts`,
  data contract §9, DESIGN 15.7): an `EventSource` on `/api/events`. `resync` compares
  `itemsVersion` and `houseEtag` with what is held and refetches the snapshot (If-None-Match)
  or just `GET /api/house`; `item.changed` is ignored only when `etag`, `path`, `stale` and
  `attachmentsEtag` all match, else `GET /api/items/{id}`; `item.deleted` drops the item;
  `house.changed` fetches the layout and re-derives item locations; `problems.changed` updates
  the badge (and an open panel). After single-item updates the held snapshot ETag and
  `itemsVersion` are treated as unknown, so the next resync/poll can't skip a real change.
  Loads, events and writes run through one ordered queue, so the event for the app's own write
  is checked after the write's response is in and is ignored (no refetch).
- **Fallback:** on an SSE error the stream closes and `GET /api/me` is called: 401 (or a
  redirect to the login page) reloads the page with `?signin=1`, at most once a minute (not on a
  page started from the service worker's saved copy, D47); otherwise reconnect after
  5 s. A stream that opens without a `resync` within 15 s (buffering proxy) counts as an error.
  After 3 errors in a row: polling `/api/snapshot` every 30 s, with an SSE retry every 60 s.
  Focus and visibility revalidate the snapshot in every mode. Hidden tab: no polling, and the
  stream is closed after 60 s (reconnect + resync on return). Status in the top bar: Live /
  Polling / Offline / Connecting (text + shape, `role="status"`; dot only on phones). A failed
  refresh keeps the last data and shows a banner. `houseReadOnly` shows a note. Timings can be
  shortened in non-production builds via `window.__housebookSyncTimings` (e2e).
- **Offline (D47):** `src/sw/sw.ts` is the service worker, built to `/sw.js` by
  `vite-plugin-sw.ts` (production builds only; `pnpm dev` has none). `src/sw/routes.ts` decides
  what it answers (never `/api/*`), `src/sw/precache.ts` what it saves on install. The data copy
  is the app's: `store/offlineCache.ts` (Cache Storage) written by `store/offlineSave.ts`, read
  by `store/data.ts` when the first load fails (`offlineAt`). `app/pwa.ts` registers the worker
  and handles `?signin`. To try it locally: `pnpm build && pnpm preview`, or `make e2e`.
- **Inconsistent states (DESIGN 15.2):** a placement whose note is missing is a dashed "note
  missing" ghost (2D button with `data-ghost-id`; translucent box + label in 3D) that opens a
  "Note missing" panel; a stale (unparseable) note keeps its last good content with a dashed
  badge and a mark (2D), a `?` badge (3D) and a notice in the panel. Relink/remove, the
  Unplaced tray and replay-on-412 are milestone 5.
- **Problems panel:** the ⚠ count opens a dialog (lazy chunk, ~2 KB) listing `/api/problems`
  grouped by kind with readable titles; entries link to their item. Editors can **Adopt** a
  `not_adopted` note (`POST /api/items/adopt`); other fixes are read-only for now. Nothing is
  fixed automatically.
- **Writes:** the role comes from `/api/me`; viewers (and an unknown role) see no write UI.
  Editors get "Add to maintenance log" in the item panel (`POST /api/items/{id}/log`, no
  If-Match; disabled while the note is unreadable).
- **Note editor (milestone 6, D31):** "Edit note" in the item panel (editors) edits the common
  fields and the Markdown body (with preview). A save sends only the changed keys
  (`PATCH /api/items/{id}`, If-Match). If the note was saved elsewhere meanwhile, changes to
  different fields are merged and saved; a field changed on both sides is shown as "theirs ·
  yours" with "Use theirs". Unsaved edits survive closing the panel (not a reload; the page warns).
- **Delete item (milestone 6, D32):** "Delete item" in the item panel (editors) takes the item off
  the plan and saves the layout, then moves the note and its attachments folder to
  `.housebook/trash/` (`DELETE /api/items/{id}`, If-Match). Undoing the "remove from plan" step
  afterwards is refused ("its note was deleted") so no ghost comes back.
- **Attachments (milestone 6, D33):** editors add files with "Add files" or by dropping them on
  the Attachments section (PDF, JPEG, PNG, WebP, HEIC; 25 MB each; uploaded one after the other),
  and remove one with ✕ → Remove (to the trash; only files in the item's own folder).
- **Floors (milestone 7, D35):** the editor's "Floors" section adds a floor above the top one or
  below the lowest, renames, moves floors up/down (levels) and deletes one with what is on it
  (confirmation lists tiles, items to the tray and doors/windows; never the last floor). Undo
  restores everything. While editing, the floor below is drawn dashed under the current one.
- **Doors and windows (milestone 7, D36):** the Door (D) and Window (W) tools: click near a wall
  edge to add one there, click it again to remove it, or with the other tool to swap it. Only on
  walls (between rooms, or a room and the outside); the targeted edge is highlighted in 2D and 3D.
- **First run (milestone 6, D34):** with no `house.json`, editors get "Set up your house" (floor
  name and size), which creates the layout and opens the editor with "Room 1" ready to paint.
  Existing items and notes still to adopt are counted. An unreadable `house.json` is never
  replaced; viewers are told someone who can edit can set it up.
- **Layout editor (milestone 5, DESIGN §7.3, D17, D23–D29):** "Edit" in the top bar (editors,
  writable layout) opens a side bar: tools Select/move (V), Paint (B), Erase (E), undo/redo,
  Resize house…, the save state, the room list (add, rename, recolour, paint with, delete when
  unused), the catalogue (Add <type> arms the place tool) and the Unplaced tray (choose or drag a
  note onto the plan). Both views turn the pointer into a grid cell and hand it to the tool;
  presses the tool doesn't want, wheel and two fingers still pan/zoom. Paint and erase take a
  dragged rectangle as one undo step; the select tool selects (a click on the selected item
  cycles a stack), drags items by whole tiles; R rotates 90° in place, Delete moves the item to
  the tray, Ctrl+Z / Ctrl+Shift+Z undo/redo, Esc cancels. A new item from the catalogue asks for a
  name, creates the note (`POST /api/items`, folder from the tile's room), then adds the
  placement (D8); undo removes only the placement. Ghosts (missing notes) get Relink (to an
  unplaced note) and Remove placement in the panel. Every edit is a command (`commands/`) shown
  at once and saved with `PUT /api/house` + `If-Match` one second after the last edit, in the data
  queue; on `412` the layout is fetched, the pending commands are replayed on it and the save is
  retried; edits that no longer apply are dropped with a message (and leave the history). A
  `house.changed` while edits are pending rebases them the same way. Resize grows or shrinks
  any side; north/west growth shifts everything; any loss is listed and needs a tick; undo
  restores it.
- **Status:** the snapshot's status is used while its `today` is still today in the household
  time zone; after midnight the client recomputes with the same rules (golden fixtures).
- **Search** runs on the client over the snapshot (D9) with the contract's folding and ranking;
  matches are highlighted on the plan, others dimmed, with per-floor counts.
- **3D view:** 2D/3D toggle next to Plan/List; 2D is the default and the only choice without
  WebGL (3D is then `aria-disabled`; tapping it shows why as page text). The choice is
  remembered per browser (`housebook.planStyle`), not in the URL; `/i/<id>` works in both. three.js and friends load
  with a dynamic import the first time 3D opens. Orthographic camera at 45°, pan (drag, arrow
  keys), zoom (wheel, pinch, + / −, 0 fits), rotate in 90° steps ([ / ] and buttons; a camera
  the user hasn't moved stays fitted), eased unless `prefers-reduced-motion`,
  `frameloop="demand"`. Floors are one mesh per room, walls one merged mesh per floor from the
  same wall edges as 2D, cut away low (0.3 m, so nothing hides behind a wall at 45°) with a
  "Walls up" toggle (2.5 m) in which the walls facing the camera keep a low solid base and fade
  above it (a second, translucent mesh; recomputed per 90° heading); doors cut gaps (lintel
  with walls up), windows leave a sill/head and a pane (a dip with the pane when cut away).
  Items are boxes (catalogue footprint × per-type height, placement footprint overrides
  honoured, the same occupied rectangle as the 2D plan; wall items against their back edge
  with their top at 1.8 m and ceiling items at the ceiling, whatever the wall height shown);
  `ItemModel.tsx` is the seam for milestone 3 models. Zoom limits and clipping planes come
  from the grid size, so the largest contract grid (512 × 512 tiles of 10 m) fits. Room
  labels, status badges (same status rules) and the hovered/selected name are DOM overlays
  placed with the camera's projection. Click an item → details; click a floor → room;
  search, list, 2D and deep-link selections centre the camera. A lost WebGL context falls
  back to 2D with a "Reload 3D" button (focus moves there if it was in the 3D view); a failed
  chunk load falls back with "Try 3D again" and is retried only on that action. three.js is
  pinned to 0.182: react-three-fiber 9.8 (latest stable) still creates a `THREE.Clock`,
  which logs a deprecation warning from three 0.183 on. The canvas is labelled as a picture
  and points to the 2D plan and the list as the accessible alternatives.
- **Routing:** `/i/<id>` opens that item (QR stickers, D16); the URL follows the selection and
  back/forward work.
- **Safety:** links in notes and in `manual`/`support` only for http, https, mailto, tel and
  obsidian; no raw HTML; remote images aren't loaded (attachments only). PDFs are rendered with
  PDF.js from fetched bytes, so the backend can serve them sandboxed too.
- **Accessibility:** items and room labels are focusable buttons with full names; status is
  always text (and a distinct shape on the plan); focus moves into the panel and back; Esc
  closes; reduced motion respected; 44 px targets on touch screens. axe runs in e2e on the plan,
  the details panel, the list, dark mode and a phone viewport.

## Known limits

- Painting very large areas is slow: the 2D plan draws one SVG `<rect>` per tile, so one
  rectangle of roughly 50–100k tiles freezes the page for over a second (milestone 8).

## Tests

- `src/domain/status.test.ts` and `search.test.ts` run `contract/fixtures/status_cases.json` and
  `search_cases.json`, the same files pytest runs, so the TS and Python rules can't drift.
  `src/domain/scene.test.ts` runs `contract/fixtures/placement_cases.json` (placement → 3D
  transform, the coordinate contract) plus wall/opening geometry on `examples/house`.
- 3D: `features/scene3d/camera.test.ts` (projection checked against three's own camera, pointer
  ↔ floor, pan/zoom anchors, 90° rotation, fit, focus, easing), `layout.test.ts`,
  `SceneContent.test.tsx` (scene graph with `@react-three/test-renderer`: one merged wall mesh,
  one floor mesh per room, item positions/rotations, selection ring, click → select, search dim,
  floor switch), `SceneOverlays.test.tsx`; `app/App.test.tsx` (toggle, no WebGL, context loss).
- Sync: `store/sync.test.ts` (state machine with a fake EventSource and fake timers: resync →
  live, reconnect, 401 reload, offline, fallback to polling and back, resync timeout, hidden
  tab, reload guard) and `store/data.test.ts` (resync diffing, the dedupe rule, own writes,
  layout-only updates, ghosts after delete). `features/problems/ProblemsPanel.test.tsx`,
  `features/details/LogEntryForm.test.tsx`, `features/plan2d/PlanSvg.test.tsx` (ghost, stale).
- Component tests: search box, item details (chips, link allowlist, Obsidian link), Markdown
  (raw HTML, `javascript:`, wikilinks), list keyboard navigation, snapshot loading (304, errors).
- Editor: `domain/layout.test.ts` (rectangles, stacking, rotate/move clamping, resize shift and
  loss), `commands/commands.test.ts` (every command applied and undone exactly, conflicts,
  idempotence, batch all-or-nothing, random edit sequences undone to the start, replay with kept
  and dropped commands), `features/editor/tools.test.ts` (tool state machines, previews) and
  `store/editor.test.ts` (debounce and If-Match, undo/redo saved, D8 order, 412 replay with and
  without drops, rebase on `house.changed`, edits during a save, 422/network errors, ghosts).
- E2E (`e2e/`, Playwright, Chromium). Known bugs are reproduced as `test.fail()` tests named
  `FE-NN: …`; when one starts passing, Playwright reports it, so drop the `test.fail` line.
  - `app.spec.ts`: core journeys (plan, dishwasher → E15, room panel, search, PDF, deep links,
    axe, phone bottom sheet).
  - `plan.spec.ts`: every floor (rooms + m², items on their tiles, openings, title block); wall
    paths equal `domain/plan.walls()` and an independent edge count; zoom buttons, keys, wheel
    (anchor stays put), drag-pan vs click, Fit, refit per floor; touch pan and pinch via CDP.
  - `panel.spec.ts`: Esc and focus return, Tab order in panel and list, room panel, image
    preview, PDF paging/zoom, deleted and corrupt attachments, Obsidian link only when
    configured, a note edited on disk.
  - `search.spec.ts`: results and order equal `GET /api/items?q=` (same contract), highlight and
    dim, per-floor counts, no results, clearing, Enter/arrows, "N more".
  - `data.spec.ts`: crafted data roots: Markdown safety (`javascript:`, raw HTML, remote images,
    wikilinks, embeds), snapshot ETag / If-None-Match / 304 and refetch on focus, failed loads,
    newer `schemaVersion` (read-only), problems count, stale and unplaced notes, empty root.
  - `live.spec.ts`: notes and `house.json` edited on disk update the page over SSE (one item /
    the layout fetched, not the snapshot), stale and deleted notes (ghost in 2D and 3D), new
    notes, polling fallback with If-None-Match and the way back to live, offline, 401 → one
    reload, the problems panel (axe, viewer read-only, editor adopt), the log entry (written to
    disk, no refetch of the app's own write), viewers without write UI.
  - `offline.spec.ts` (the only spec with the service worker on; `playwright.config.ts` blocks
    it elsewhere): a deep link with the server stopped opens from the saved app and data,
    read-only; a login redirect to an unreachable provider still opens it, with "Sign in again"
    and no reload; `?signin` is dropped from the address.
  - `ui.spec.ts`: theme toggle and dark mode (axe), reduced motion, 360 px (no horizontal
    scroll, 44 px targets), the after-midnight status recompute, and four screenshots (incl. 3D)
    (`ui.spec.ts-snapshots/`, fixed clock and viewport, animations off). Update them with
    `pnpm exec playwright test --grep @visual --update-snapshots` and review the diff.
  - `scene3d.spec.ts`: the 3D view in Chromium/SwiftShader through the test hook: toggle and lazy
    chunk (requested once), persistence, demand rendering, click → details, click floor → room,
    drag pans without selecting, search and deep link centre the camera, floor switch, rotate
    (buttons, keys), zoom/fit/walls up, reduced motion, no WebGL, context loss → 2D → reload,
    keyboard and axe; fails on any uncaught page error. Its `@smoke` test runs on the Docker
    image too and checks that the hook isn't there.
  - `gaps.spec.ts`: Find manual online, Copy path (with the select fallback), heading wikilinks,
    protocol-relative links, match counts only where there are matches, two-finger pan.
  - `editor.spec.ts`: the layout editor against a real backend (editor role), checking
    `house.json` on disk: edit mode and axe, rectangle paint and erase with undo/redo, a new item
    from the catalogue (note file, then placement), move/rotate/remove/place from the tray, drag
    from the tray, stack cycling, rooms, resize growing (shift) and shrinking (loss, confirmation,
    undo), one debounced PUT with If-Match, 412 replay (kept and dropped edits, SSE blocked),
    an SSE layout change while an edit is pending, ghost relink/remove, and paint/move/place
    in 3D.
  - `editor-verify.spec.ts`: milestone 5 verification: rectangles past the grid edge, Esc
    mid-drag, Ctrl+Z inside a text field, growth on every side (exact shift), 1 × 1 and 512 × 512,
    shrink + tray + undo, rotation near the edge, undoing a new item (note kept), name clashes,
    ghost relink undo and Delete, leaving edit mode/the page, network errors, viewers, 2D ↔ 3D
    mid-edit, read-only while pending, two tabs, phone; other writers' resizes (translated,
    ambiguous or mixed → dropped with a message, pending own resize), lost save responses, D30
    repairs (all problems at once, undo before/after save, beyond 512, races with another tab or
    an external edit), ordinary edits by another writer not taken for a shift, rooms recreated
    from odd/long/empty ids, house.json invalid then valid again (SSE on/off), first-run houses
    with few or no anchors; known bugs as
    `M5-NN` `test.fail()`s.
  - `retest.spec.ts`: regression probes for the FE-01…FE-09 fixes: keyboard-only and backdrop
    dialog closing, a refresh landing mid-drag or mid-pinch, every read-only house.json cause,
    Esc with an empty query, refused clipboard, link tricks (`//host`, `/\\host`, entity- and
    control-character `javascript:`), one finger lifting mid-pinch, PDFs under `CSP sandbox`.
- Test support: `e2e/support/fixtures.ts` (locators, axe helper, the `backend` fixture that
  starts a private backend on a crafted temp data root and deletes it afterwards) and
  `e2e/support/server.ts` (data-root builder, free port, PDF/PNG generators). Tags: `@phone` runs
  only in the phone project, `@smoke` also in `pnpm e2e:docker`, `@visual` marks screenshots.
