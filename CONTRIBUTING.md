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

## Running parts on their own

`make dev` is enough for most work. To run only the backend on the example data (with
[uv](https://docs.astral.sh/uv/), which fetches Python 3.13 if needed):

```sh
cd apps/api
uv sync
HOUSEBOOK_DATA_DIR=../../examples/house HOUSEBOOK_TZ=Europe/Athens uv run housebook serve
# http://127.0.0.1:8000/api/snapshot   http://127.0.0.1:8000/api/docs
```

The server creates `<data>/.housebook/lock` (git-ignored) and refuses to start if another
instance holds it.

Backend tests and lint, without the rest of `make check`:

```sh
cd apps/api
uv run pytest          # parser + nasty vault, golden fixtures, problems, API, path safety
uv run ruff check src tests && uv run ruff format --check src tests
```

After changing the `house.json` model, regenerate the schema (a test fails otherwise):

```sh
uv run housebook schema --out ../../contract/house.schema.json
```

To build the image from source and run it on the example house with the development
`compose.yaml` at the root of the repository (the install file is `deploy/compose.yaml`):

```sh
docker build -t housebook .
HB_UID=$(id -u) HB_GID=$(id -g) docker compose up --build    # serves examples/house on 127.0.0.1:8000
```

Use `HB_UID`/`HB_GID`, not `UID`/`GID`: bash treats `UID` as read-only, so `UID=… docker compose`
fails or is ignored and the container quietly runs as 1000.

## Where things live

```
contract/      the agreement between backend and frontend: house.json schema, catalog, golden
               test cases both sides run. Changes here need a review from both sides.
apps/api/      FastAPI backend (see apps/api/README.md for its layers)
apps/web/      React frontend (see apps/web/README.md for its layout)
examples/      example data, used by the dev server and the tests
site/          the project page on GitHub Pages (`make site` builds it into _site/; its install
               steps must match deploy/compose.yaml, which CI checks)
docs/          DESIGN.md (architecture and decisions), data-contract.md (file formats, API rules)
               configuration.md, api.md, login.md, backup.md, releasing.md: for people who
               run it
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

## License

Housebook is licensed under the GNU Affero General Public License, version 3 or later
(`LICENSE`). By opening a pull request you agree that your contribution is licensed the same way.
Code or assets copied from elsewhere must have a compatible licence; note where they came from
(as `apps/web/src/assets/models/LICENSES.md` does for the 3D models).
