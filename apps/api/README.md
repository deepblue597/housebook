# housebook-api

FastAPI backend for Housebook. See the repository README for running it and
`docs/data-contract.md` for the file formats.

```
src/housebook/
  domain/      pure rules: house.json model, frontmatter, item fields, status, search, catalog,
               note_edit (minimal-diff frontmatter edits, merge patch, log append), file names
  migrations/  house.json migrations (dict -> dict)
  ports.py     Protocols: HouseRepo, NoteRepo, AttachmentStore, SearchIndex
  adapters/    filesystem (atomic writes, history, trash) + in-memory search implementations
  services/    indexer: full scan -> immutable in-memory index
               writer:  the write operations (preconditions against the file on disk)
               sync:    one lock for all changes; rescan -> diff -> SSE events (delete grace,
                        parse retry, echo suppression by hash); the watchfiles watcher
               oidc, sessions: the built-in login (D48): provider calls and ID token checks,
                        signed cookies and the session key
  api/         FastAPI app, routes, auth (who is asking), login (/api/auth/*), SPA serving
  config.py    settings from HOUSEBOOK_* env vars
  lock.py      single-process flock on <data>/.housebook/lock; network-filesystem check

Every change (API write, watcher batch, periodic rescan) runs Sync: full rescan under one
lock, then the diff against what clients were last told becomes events. No per-path index
updates; a scan of a few hundred notes is milliseconds.
```

## Tests

```
tests/             unit + in-process API tests (default `uv run pytest`)
tests/api/         tester suite, in-process: contract conformance (JSON Schema, OpenAPI
                   responses), edge cases; known bugs are strict xfails tagged HB-xx
tests/blackbox/    opt-in: real `housebook serve` processes and the Docker image
```

```sh
uv run pytest                                                  # default, ~15 s (watcher tests use real inotify)
HOUSEBOOK_BLACKBOX=1 uv run pytest tests/blackbox              # real server processes, ~25 s
HOUSEBOOK_BLACKBOX=1 HOUSEBOOK_DOCKER=1 uv run pytest tests/blackbox   # + Docker image (builds housebook:blackbox)
HOUSEBOOK_BLACKBOX=1 uv run pytest tests/blackbox -k performance -s    # prints PERF stats for 500 notes
```
