# housebook-api

FastAPI backend for Housebook. See the repository README for running it and
`docs/data-contract.md` for the file formats.

```
src/housebook/
  domain/      pure rules: house.json model, frontmatter, item fields, status, search, catalog
  migrations/  house.json migrations (dict -> dict)
  ports.py     Protocols: HouseRepo, NoteRepo, AttachmentStore, SearchIndex
  adapters/    filesystem + in-memory search implementations
  services/    indexer: full scan -> immutable in-memory index
  api/         FastAPI app, routes, auth, SPA serving
  config.py    settings from HOUSEBOOK_* env vars
  lock.py      single-process flock on <data>/.housebook/lock
```

## Tests

```
tests/             unit + in-process API tests (default `uv run pytest`)
tests/api/         tester suite, in-process: contract conformance (JSON Schema, OpenAPI
                   responses), edge cases; known bugs are strict xfails tagged HB-xx
tests/blackbox/    opt-in: real `housebook serve` processes and the Docker image
```

```sh
uv run pytest                                                  # default, ~3 s
HOUSEBOOK_BLACKBOX=1 uv run pytest tests/blackbox              # real server processes, ~25 s
HOUSEBOOK_BLACKBOX=1 HOUSEBOOK_DOCKER=1 uv run pytest tests/blackbox   # + Docker image (builds housebook:blackbox)
HOUSEBOOK_BLACKBOX=1 uv run pytest tests/blackbox -k performance -s    # prints PERF stats for 500 notes
```
