# Housebook: notes for AI coding agents

Read `CONTRIBUTING.md` first; everything there applies. In short:

- Self-hosted household app. Backend: FastAPI in `apps/api` (uv). Frontend: React + Vite in
  `apps/web` (pnpm). Shared rules and test cases: `contract/`. Formats and API rules:
  `docs/data-contract.md`. Architecture and numbered decisions: `docs/DESIGN.md`.
- Work on a branch, never on `main`. Don't push or open pull requests unless asked.
- Before calling a change done, run `make check` (and `make e2e` for UI changes) and report
  failures as they are.
- Changed the `house.json` model or an API route? Run `make schema` and commit the generated
  files. Don't edit `contract/house.schema.json`, `apps/web/src/api/openapi.json` or
  `apps/web/src/api/schema.gen.ts` by hand.
- Changed a format, status rule, search or API behaviour? Update `docs/data-contract.md` in the
  same change. New design decisions get a `D<n>` row in `docs/DESIGN.md`.
- Use `make dev` (serves the git-ignored `.dev-data/`), not `examples/house` directly: the example
  data is used by the tests.
- `apps/web/src/domain` and `apps/web/src/commands` are pure TypeScript (no React); layout edits are
  commands with exact inverses (D24). Follow the existing command pattern for new edits.
