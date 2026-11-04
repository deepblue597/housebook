# housebook-web (placeholder)

The React + TypeScript SPA (2D plan, list, details; 3D lazy-loaded) lands here in the
frontend half of milestone 1. It consumes:

- `GET /api/snapshot` for first load, polling with `If-None-Match`, and offline cache;
- the shared contract in `/contract`: `house.schema.json`, `catalog.json`, and the golden
  fixtures `fixtures/status_cases.json` and `fixtures/search_cases.json`, which vitest must
  run against `src/domain` exactly as pytest does against the backend;
- API types generated from `/api/openapi.json` with `openapi-typescript`.

The Dockerfile has a commented-out `web` stage; enable it once `pnpm build` produces `dist/`.
