# API

Every route the app uses, for scripts and integrations. The full rules (preconditions, error
bodies, event payloads) are in [data-contract.md](data-contract.md) §8–9. A running Housebook
also serves the OpenAPI description at `/api/docs`.

| Method | Path | |
|---|---|---|
| GET | `/api/house` | Layout; `ETag`, `If-None-Match` → 304; `X-Housebook-Read-Only` for newer schema versions |
| PUT | `/api/house` | Replace the layout (editor). `If-Match` (428/412), full validation (422 with every issue), history in `.housebook/history/` (last 50), atomic deterministic write; 409 when read-only |
| GET | `/api/snapshot` | House + all items (fields, status, body, attachments) + your own textures + `itemsVersion`, `texturesVersion`; `ETag`/304. Poll this when SSE fails |
| GET | `/api/items?q=&due=` | Search (contract §5) and/or "due within N days" |
| POST | `/api/items` | Create a note `House/<Room>/<Name>.md` from `{type, name?, roomId?, frontmatter?, body?}` (editor). The client places it with `PUT /api/house` afterwards |
| GET | `/api/items/{id}` | One item; `ETag` = note content hash (the `If-Match` for writes) |
| PATCH | `/api/items/{id}` | `{frontmatter?: <JSON Merge Patch>, body?}` with `If-Match` (editor). Minimal-diff frontmatter edit |
| DELETE | `/api/items/{id}` | Move the note (and its attachment folder) to `.housebook/trash/` (`If-Match`, editor) |
| POST | `/api/items/{id}/attachments?name=` | Upload a file as the raw body (`application/octet-stream`, editor): PDF, JPEG, PNG, WebP or HEIC by content, ≤ 25 MiB; photos are saved again without metadata (GPS), HEIC as JPEG; stored in the item's attachments folder and listed in `attachments` |
| DELETE | `/api/items/{id}/attachments/{name}` | Move a file from the item's attachments folder to `.housebook/trash/` and unlist it (editor) |
| POST | `/api/items/{id}/log` | Append `- YYYY-MM-DD text` under `## Maintenance log` (`{text, date?}`, no `If-Match`, editor) |
| POST | `/api/items/adopt` | Give a tagged note without `housebook_id` (a `not_adopted` problem) an id (`{path}`, editor) |
| GET | `/api/events` | Server-sent events: `resync` on connect, then `house.changed`, `item.changed`, `item.deleted`, `problems.changed`, `textures.changed`; a `ping` event after 20 s of silence |
| GET | `/api/items/{id}/attachments/{name}` | File download; Range, `nosniff`, sandbox CSP (PDFs too: the web app renders them with PDF.js) |
| POST | `/api/textures?kind=&label=&width=&height=` | Your own floor or wallpaper (editor): an image as the raw body, cleaned like an attachment and shrunk to 1024 px, stored in `Textures/` and listed in `Textures/textures.json` under a `my_` key; `width`/`height` are the metres one repeat covers |
| GET | `/api/textures/{key}` | A texture's image |
| DELETE | `/api/textures/{key}` | Move a texture's image to `.housebook/trash/` (editor); 409 while a room uses it |
| GET | `/api/problems` | Integrity report |
| GET | `/api/catalog` | Item types |
| GET | `/api/me` | Who is signed in (`user`, `name`), their role, the login mode and where "Log out" goes |
| GET | `/api/auth/login`, `/callback`, `/logout` | The built-in login (`oidc` mode only; data contract §11) |
| GET, POST, DELETE | `/api/calendar/link` | The caller's calendar link (any signed-in role): whether there is one; make a new one (the URL is returned only then); turn it off |
| GET | `/api/calendar.ics?token=` | Calendar feed of next checks and warranty ends (iCalendar). **No login**: the code in the link is the key |
| GET | `/api/export` | The data folder as a zip, streamed (editor): notes, attachments, layout, textures, layout history and trash; not the lock, unfinished uploads or the login key ([backup.md](backup.md)) |
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
Never expose `none` mode to the internet ([login.md](login.md)).
