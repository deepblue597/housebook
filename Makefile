# Housebook developer commands. Run `make help` for the list.
# Needs: uv, Node 24 and pnpm (version pinned in apps/web/package.json).

API := apps/api
WEB := apps/web
# Dev data: a git-ignored copy of examples/house, so editing in the dev server never changes
# the tracked example files. `make reset-data` starts it over.
DEV_DATA := .dev-data

.DEFAULT_GOAL := help
.PHONY: help setup dev api web reset-data check check-api check-web test e2e fmt schema docker

help: ## Show this list
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-11s %s\n", $$1, $$2}'

setup: ## Install backend and frontend dependencies and the Playwright browser
	cd $(API) && uv sync
	cd $(WEB) && pnpm install && pnpm exec playwright install chromium

$(DEV_DATA):
	mkdir -p $(DEV_DATA)
	cp -R examples/house/. $(DEV_DATA)/
	rm -rf $(DEV_DATA)/.housebook

reset-data: ## Replace the dev data with a fresh copy of examples/house
	rm -rf $(DEV_DATA)
	$(MAKE) $(DEV_DATA)

dev: $(DEV_DATA) ## Run backend (:8000) and frontend dev server (:5173) together
	$(MAKE) -j2 api web

api: $(DEV_DATA) ## Run only the backend, as an editor, on the dev data
	cd $(API) && HOUSEBOOK_DATA_DIR=../../$(DEV_DATA) HOUSEBOOK_TZ=Europe/Athens \
		HOUSEBOOK_ANON_ROLE=editor HOUSEBOOK_HOST=127.0.0.1 uv run housebook serve

web: ## Run only the frontend dev server (proxies /api to :8000)
	cd $(WEB) && pnpm dev

check: check-api check-web ## Everything CI runs on a pull request (except the browser tests)

check-api: ## Backend: lint, formatting, tests
	cd $(API) && uv run ruff check src tests && uv run ruff format --check src tests && uv run pytest -q

check-web: ## Frontend: types, lint, formatting, unit tests, API client up to date, size budget
	cd $(WEB) && pnpm check && pnpm size

test: ## Unit tests only, both sides
	cd $(API) && uv run pytest -q
	cd $(WEB) && pnpm test

e2e: ## Browser tests (Playwright) against the real backend
	cd $(WEB) && pnpm e2e

fmt: ## Format and auto-fix both sides
	cd $(API) && uv run ruff format src tests && uv run ruff check --fix src tests
	cd $(WEB) && pnpm format

schema: ## Regenerate contract/house.schema.json and the frontend API client after model/API changes
	cd $(API) && uv run housebook schema --out ../../contract/house.schema.json
	cd $(WEB) && pnpm gen:api

docker: ## Build the Docker image as housebook:dev
	docker build -t housebook:dev .
