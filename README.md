# Housebook

Self-hosted household app: a plan of your home where clicking an appliance shows its manual,
warranty, quick fixes and maintenance log. Item info is plain Markdown with YAML frontmatter
(Obsidian-compatible, Obsidian optional); the layout is `house.json`. One Docker container,
one household.

Status: milestones 0–5: the data contract; the web UI with 2D plan, list, details, search and the
3D view; writes (`PUT /api/house`, item create/patch/delete/log), the file watcher, server-sent
events, live sync and the problems panel (milestone 4); and the **layout editor** (milestone 5):
edit mode for editors with paint/erase (rectangle drag), place/move/rotate items, rooms, resizing
the house, undo/redo, debounced saving with replay on `412`, the Unplaced tray and ghost relinking,
in 2D and 3D. See `apps/web/README.md`.

```
contract/           shared by backend and frontend
  house.schema.json   generated from the Pydantic model
  catalog.json        item types
  fixtures/           golden status and search cases (run by pytest and vitest)
apps/api/           FastAPI backend (uv project)
apps/web/           React SPA (pnpm project; see apps/web/README.md)
examples/house/     example data root: house.json + House/<Room>/<Item>.md
docs/DESIGN.md      design and architecture review
docs/data-contract.md   house.json v1, frontmatter, status, search, problems
```

## Run locally

Requires [uv](https://docs.astral.sh/uv/) (it fetches Python 3.13 if needed).

```sh
cd apps/api
uv sync
HOUSEBOOK_DATA_DIR=../../examples/house HOUSEBOOK_TZ=Europe/Athens uv run housebook serve
# http://127.0.0.1:8000/api/snapshot   http://127.0.0.1:8000/api/docs
```

The server creates `<data>/.housebook/lock` (git-ignored) and refuses to start if another
instance holds it.

## Tests

```sh
cd apps/api
uv run pytest          # parser + nasty vault, golden fixtures, problems, API, path safety
uv run ruff check src tests && uv run ruff format --check src tests
```

After changing the `house.json` model, regenerate the schema (a test fails otherwise):

```sh
uv run housebook schema --out ../../contract/house.schema.json
```

## Docker

```sh
docker build -t housebook .
HB_UID=$(id -u) HB_GID=$(id -g) docker compose up --build    # serves examples/house on 127.0.0.1:8000
```

Use `HB_UID`/`HB_GID`, not `UID`/`GID`: bash treats `UID` as read-only, so `UID=… docker compose`
fails or is ignored and the container quietly runs as 1000.

The image runs as a non-root user (UID/GID 1000 by default; `--build-arg UID=… --build-arg GID=…`
to change, which compose does from `HB_UID`/`HB_GID`), works with a read-only root filesystem (only `/data` is written), and
has a `HEALTHCHECK` on `/readyz`. Mount a **directory** at `/data`, not a single file. Run
exactly one instance per data root (`replicas: 1`, `strategy: Recreate` on k3s).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOUSEBOOK_DATA_DIR` | `/data` | Data root (contains `house.json`) |
| `HOUSEBOOK_NOTES_DIR` | `House` | Notes folder, relative to the data root (may be nested, e.g. `Notes/Home`). Only `*.md` here are items. Rejected at startup: `.` (the data root itself) and hidden/temporary names the scanner skips (`.hb`, `*~`, `*.tmp`, …) |
| `HOUSEBOOK_OBSIDIAN_VAULT` | – | Vault name; enables `obsidian://` links in item responses |
| `HOUSEBOOK_OBSIDIAN_VAULT_SUBPATH` | – | Path of the data root inside the vault, e.g. `Housebook` |
| `HOUSEBOOK_TZ` | `$TZ`, else `UTC` | Household time zone; decides "today" for statuses |
| `HOUSEBOOK_AUTH_MODE` | `none` | `none` or `proxy` (`oidc` is reserved, not implemented) |
| `HOUSEBOOK_ANON_ROLE` | `viewer` | Role for everyone in `none` mode; `editor` must be set explicitly |
| `HOUSEBOOK_TRUSTED_PROXIES` | – | Comma-separated IPs/CIDRs of the auth proxy. Required in `proxy` mode |
| `HOUSEBOOK_EDITOR_GROUP` | `housebook-editors` | Group (from `X-Forwarded-Groups`) that grants `editor`. A full path such as `/home/housebook-editors` matches exactly that group (**recommended**, stricter). A bare name matches that name at any depth (`/housebook-editors`, `/kids/housebook-editors`, …). Case-sensitive, like Keycloak group names |
| `HOUSEBOOK_WATCH` | `inotify` | How file changes made outside the app (Obsidian, Syncthing, a file manager) are noticed. `inotify`: native events (falls back to `poll` if they can't be set up). `poll`: a full rescan every `HOUSEBOOK_POLL_INTERVAL`; use it on NFS, SMB, 9p and Docker Desktop shares, which don't deliver events for changes made by other machines (a warning is logged at startup when the data folder is on one). `off`: only the periodic rescan |
| `HOUSEBOOK_POLL_INTERVAL` | `5` | Seconds between rescans with `HOUSEBOOK_WATCH=poll` (0.1–3600) |
| `HOUSEBOOK_RESCAN_INTERVAL` | `600` | Seconds between full rescans, whatever the watch mode (`0` disables). The watcher is for speed; this is the correctness path |
| `HOUSEBOOK_STATIC_DIR` | – (`/app/web` in Docker) | Built SPA to serve; any non-`/api` GET falls back to `index.html` |
| `HOUSEBOOK_CONTRACT_DIR` | repo `contract/` (`/app/contract` in Docker) | Where `catalog.json` is read from |
| `HOUSEBOOK_HOST` / `HOUSEBOOK_PORT` | `0.0.0.0` / `8000` | Listen address |
| `HOUSEBOOK_LOG_LEVEL` | `INFO` | JSON logs to stdout |

A variable set to an empty value counts as unset.

### Proxy auth (oauth2-proxy + Keycloak)

With `HOUSEBOOK_AUTH_MODE=proxy`, `X-Forwarded-User` and `X-Forwarded-Groups` are trusted only
when the TCP peer is in `HOUSEBOOK_TRUSTED_PROXIES`; any other request to `/api` gets `401`.
Set `HOUSEBOOK_EDITOR_GROUP` to the full Keycloak group path (e.g. `/home/housebook-editors`) so
that only that exact group grants editing; a bare name also matches same-named subgroups anywhere
in the tree. Matching is case-sensitive. Don't publish the container port; keep it on an internal network behind the proxy.
`/healthz` and `/readyz` need no auth; `/api/docs` and `/api/openapi.json` follow the same rule as
the rest of `/api`.

## API

Full rules (preconditions, error bodies, event payloads): `docs/data-contract.md` §8–9.

| Method | Path | |
|---|---|---|
| GET | `/api/house` | Layout; `ETag`, `If-None-Match` → 304; `X-Housebook-Read-Only` for newer schema versions |
| PUT | `/api/house` | Replace the layout (editor). `If-Match` (428/412), full validation (422 with every issue), history in `.housebook/history/` (last 50), atomic deterministic write; 409 when read-only |
| GET | `/api/snapshot` | House + all items (fields, status, body, attachments) + `itemsVersion`; `ETag`/304. Poll this when SSE fails |
| GET | `/api/items?q=&due=` | Search (contract §5) and/or "due within N days" |
| POST | `/api/items` | Create a note `House/<Room>/<Name>.md` from `{type, name?, roomId?, frontmatter?, body?}` (editor). The client places it with `PUT /api/house` afterwards |
| GET | `/api/items/{id}` | One item; `ETag` = note content hash (the `If-Match` for writes) |
| PATCH | `/api/items/{id}` | `{frontmatter?: <JSON Merge Patch>, body?}` with `If-Match` (editor). Minimal-diff frontmatter edit |
| DELETE | `/api/items/{id}` | Move the note (and its attachment folder) to `.housebook/trash/` (`If-Match`, editor) |
| POST | `/api/items/{id}/log` | Append `- YYYY-MM-DD text` under `## Maintenance log` (`{text, date?}`, no `If-Match`, editor) |
| POST | `/api/items/adopt` | Give a tagged note without `housebook_id` (a `not_adopted` problem) an id (`{path}`, editor) |
| GET | `/api/events` | Server-sent events: `resync` on connect, then `house.changed`, `item.changed`, `item.deleted`, `problems.changed`; a `ping` event after 20 s of silence |
| GET | `/api/items/{id}/attachments/{name}` | File download; Range, `nosniff`, sandbox CSP (PDFs too: the web app renders them with PDF.js) |
| GET | `/api/problems` | Integrity report |
| GET | `/api/catalog` | Item types |
| GET | `/api/me` | Current user and role |
| GET | `/healthz`, `/readyz` | Liveness; readiness = first scan done and data root writable |
| GET | `/api/docs`, `/api/openapi.json` | OpenAPI (same auth as `/api`) |

Every GET route also answers HEAD. JSON (and the SPA's text assets) is gzip-compressed when the
client accepts gzip (`gzip;q=0` is honoured); attachments, images, partial responses and event
streams are not. Compressible responses carry `Vary: Accept-Encoding` (304s too) and a weak ETag
for gzip-accepting clients. `/api/house`, `/api/items/{id}` and attachments are never compressed,
so their ETag stays the strong file hash used for `If-Match`/`If-Range`; neither are responses to
writes.

Writes need `Content-Type: application/json` (CSRF guard) and the `editor` role. With
`HOUSEBOOK_AUTH_MODE=none` everyone is a viewer unless `HOUSEBOOK_ANON_ROLE=editor` is set.

### Reverse proxy and SSE

`/api/events` is a long-lived stream. nginx: `proxy_buffering off; proxy_http_version 1.1;
proxy_read_timeout 1h;` (the app also sends `X-Accel-Buffering: no`); ingress-nginx: the
`proxy-buffering: "off"` and `proxy-read-timeout` annotations. Traefik streams fine; don't apply a
compress middleware to `text/event-stream`. Use HTTP/2 at the proxy: over HTTP/1.1 browsers allow
6 connections per host and every open tab holds one stream.

## Restore test

Stop the container, restore the data folder from backup, start it, and check
`GET /api/problems` is empty. There is no cache to delete: the index is in memory.
