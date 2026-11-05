# housebook-web

The Housebook SPA (milestone 1, read-only): the 2D floor plan, a Floor → Room → Item list,
item and room details, and client-side search. React + TypeScript + Vite, Zustand for state.
The 3D view (milestone 2) will be a lazy chunk next to `features/plan2d`.

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

| Script                               | What                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                          | Unit and component tests (vitest + Testing Library, jsdom)                                                                                                                                                                     |
| `pnpm e2e`                           | Builds, starts the real backend on a temp copy of `examples/house` (port 8766, `E2E_PORT` to change) and runs Playwright (desktop + phone projects, axe, visual baseline). First time: `pnpm exec playwright install chromium` |
| `pnpm e2e:docker`                    | Opt-in: builds the image from the repo root (or uses `HOUSEBOOK_IMAGE`), runs it hardened on a temp copy of `examples/house` (port 8767) and runs the `@smoke` tests against it. Removes the container and copy afterwards     |
| `pnpm size`                          | After a build: initial JS must be ≤ 200 KB gzipped (DESIGN 15.10). Lazy chunks are listed but don't count. `ANALYZE=1 pnpm build` adds `dist/stats.html`                                                                       |
| `pnpm gen:api`                       | Regenerates `src/api/openapi.json` and `src/api/schema.gen.ts` from the FastAPI app object (no server needed)                                                                                                                  |
| `pnpm check:api`                     | Fails if the committed client differs from the backend's spec (CI contract check, DESIGN 15.15)                                                                                                                                |
| `pnpm typecheck` / `lint` / `format` | `tsc -b` (strict), ESLint (typescript-eslint, react-hooks, jsx-a11y), Prettier                                                                                                                                                 |
| `pnpm check`                         | All of the static checks plus unit tests                                                                                                                                                                                       |

## Layout (DESIGN §7.2)

```
src/
  domain/      pure TS, no React: text folding, search, status rules, dates, notes conventions
               (error codes, maintenance log), coordinates, walls/areas/labels, colour contrast,
               URL allowlist, wikilinks. ESLint forbids UI imports here.
  catalog/     item types from contract/catalog.json, type icons
  api/         generated OpenAPI types + a small typed fetch client
  store/       Zustand: data (snapshot + ETag), ui (view, floor, selection, query, theme),
               the derived read model, search results
  features/
    plan2d/    SVG plan, pan/zoom (mouse, wheel, touch pinch)
    list/      list view with arrow-key navigation
    details/   item and room panel, Markdown notes (lazy), attachments, PDF.js viewer (lazy)
    search/    search combobox
  app/         shell, router (/i/<id>), theme
  components/  shared UI bits (dialog, status wording)
```

The shared contract is imported as `@contract/…` (`../../contract`).

## Behaviour notes

- **Data:** one `GET /api/snapshot`, revalidated with `If-None-Match` on window focus and tab
  visibility. A failed refresh keeps the last data and shows a banner. `houseReadOnly` shows a
  note; a non-zero `problemCount` shows a small ⚠ count linking to `/api/problems`.
- **Status:** the snapshot's status is used while its `today` is still today in the household
  time zone; after midnight the client recomputes with the same rules (golden fixtures).
- **Search** runs on the client over the snapshot (D9) with the contract's folding and ranking;
  matches are highlighted on the plan, others dimmed, with per-floor counts.
- **Routing:** `/i/<id>` opens that item (QR stickers, D16); the URL follows the selection and
  back/forward work.
- **Safety:** links in notes and in `manual`/`support` only for http, https, mailto, tel and
  obsidian; no raw HTML; remote images aren't loaded (attachments only). PDFs are rendered with
  PDF.js from fetched bytes, so the backend can serve them sandboxed too.
- **Accessibility:** items and room labels are focusable buttons with full names; status is
  always text (and a distinct shape on the plan); focus moves into the panel and back; Esc
  closes; reduced motion respected; 44 px targets on touch screens. axe runs in e2e on the plan,
  the details panel, the list, dark mode and a phone viewport.

## Tests

- `src/domain/status.test.ts` and `search.test.ts` run `contract/fixtures/status_cases.json` and
  `search_cases.json`, the same files pytest runs, so the TS and Python rules can't drift.
- Component tests: search box, item details (chips, link allowlist, Obsidian link), Markdown
  (raw HTML, `javascript:`, wikilinks), list keyboard navigation, snapshot loading (304, errors).
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
  - `ui.spec.ts`: theme toggle and dark mode (axe), reduced motion, 360 px (no horizontal
    scroll, 44 px targets), the after-midnight status recompute, and three screenshots
    (`ui.spec.ts-snapshots/`, fixed clock and viewport, animations off). Update them with
    `pnpm exec playwright test --grep @visual --update-snapshots` and review the diff.
  - `gaps.spec.ts`: Find manual online, Copy path (with the select fallback), heading wikilinks,
    protocol-relative links, match counts only where there are matches, two-finger pan.
  - `retest.spec.ts`: regression probes for the FE-01…FE-08 fixes: keyboard-only and backdrop
    dialog closing, a refresh landing mid-drag or mid-pinch, every read-only house.json cause,
    Esc with an empty query, refused clipboard, link tricks (`//host`, `/\\host`, entity- and
    control-character `javascript:`), one finger lifting mid-pinch, PDFs under `CSP sandbox`.
- Test support: `e2e/support/fixtures.ts` (locators, axe helper, the `backend` fixture that
  starts a private backend on a crafted temp data root and deletes it afterwards) and
  `e2e/support/server.ts` (data-root builder, free port, PDF/PNG generators). Tags: `@phone` runs
  only in the phone project, `@smoke` also in `pnpm e2e:docker`, `@visual` marks screenshots.
