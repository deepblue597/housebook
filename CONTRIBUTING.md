# Contributing to Housebook

## Setup

You need [uv](https://docs.astral.sh/uv/) (it fetches Python 3.13), Node 24 and pnpm at the
version pinned in `apps/web/package.json` (`npm i -g pnpm@<version>`).

```sh
make setup     # backend and frontend dependencies, Playwright's Chromium
make dev       # backend on :8000 + frontend on http://localhost:5173
```

`make dev` serves `.dev-data/`, a git-ignored copy of `examples/house`, with editing allowed.
Change things freely; `make reset-data` gives you a fresh copy. `make help` lists every command.

## How changes get in

1. Branch from `main`: `feat/…`, `fix/…`, `chore/…`, `docs/…`.
2. Run `make check` before pushing. It is what CI runs on every pull request; run `make e2e`
   too when you touched the UI.
3. Open a pull request into `main`. It merges when CI is green and someone else has reviewed it
   (code owners for the paths they own, see `.github/CODEOWNERS`). Nobody pushes to `main`
   directly.
4. Keep pull requests to one topic. Write commit messages in the imperative ("Add floor editing").

## Where things live

```
contract/      the agreement between backend and frontend: house.json schema, catalog, golden
               test cases both sides run. Changes here need a review from both sides.
apps/api/      FastAPI backend (see apps/api/README.md for its layers)
apps/web/      React frontend (see apps/web/README.md for its layout)
examples/      example data, used by the dev server and the tests
docs/          DESIGN.md (architecture and decisions), data-contract.md (file formats, API rules)
```

## Generated files

Never edit these by hand; regenerate them and commit the result with your change:

| When you change | Run | Updates |
|---|---|---|
| the `house.json` model (`apps/api/src/housebook/domain/house.py`) | `make schema` | `contract/house.schema.json` |
| any API route or response model | `make schema` | `apps/web/src/api/openapi.json`, `schema.gen.ts` |

CI fails when they are out of date.

## Rules worth knowing

- **Behaviour is defined in `docs/data-contract.md`.** If a change alters a file format, a status
  rule, search or an API response, update that document in the same pull request, and add a case
  to `contract/fixtures/` when both sides implement the rule.
- **Design decisions** go in the decisions table at the end of `docs/DESIGN.md` (`D<n>`), with
  the reason, in the same pull request as the code.
- **Tests come with the change:** backend tests in `apps/api/tests/`, frontend unit tests next to
  the code (`*.test.ts`), browser tests in `apps/web/e2e/`.
- The frontend's initial JavaScript must stay under 200 KB gzipped (`pnpm size`, part of
  `make check`). Heavy code (3D, PDF, Markdown) is loaded lazily.
- The app never deletes a user's notes without a way back (trash, undo). Keep it that way.
