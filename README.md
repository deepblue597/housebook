# Housebook

Self-hosted household app: a plan of your home where clicking an appliance shows its manual,
warranty, quick fixes and maintenance log. Item info is plain Markdown with YAML frontmatter
(Obsidian-compatible, Obsidian optional); the layout is `house.json`. One Docker container,
one household.

Status: **milestone 0** (data contract) and **milestone 1** (read-only API and web UI: 2D plan,
list, details, search). No writes, file watcher or SSE yet (milestone 4).

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
| `HOUSEBOOK_WATCH` | `inotify` | `inotify`, `poll` or `off`. Accepted now; the watcher arrives in milestone 4 |
| `HOUSEBOOK_RESCAN_INTERVAL` | `600` | Seconds between full rescans (`0` disables) |
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

## API (read-only, milestone 1)

| Method | Path | |
|---|---|---|
| GET | `/api/house` | Layout; `ETag`, `If-None-Match` → 304; `X-Housebook-Read-Only` for newer schema versions |
| GET | `/api/snapshot` | House + all items (fields, status, body, attachments); `ETag`/304. Poll this |
| GET | `/api/items?q=&due=` | Search (contract §5) and/or "due within N days" |
| GET | `/api/items/{id}` | One item; `ETag` = note content hash (the future `If-Match`) |
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
so their ETag stays the strong file hash used for `If-Match`/`If-Range`.

## Restore test

Stop the container, restore the data folder from backup, start it, and check
`GET /api/problems` is empty. There is no cache to delete: the index is in memory.
