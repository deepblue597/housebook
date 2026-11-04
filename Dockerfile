# syntax=docker/dockerfile:1
# Housebook: one image, one process. Build context = repo root.
#   docker build -t housebook .
#   docker build --build-arg UID=1001 --build-arg GID=1001 -t housebook .

ARG PYTHON_VERSION=3.13

# ---- web: the SPA (milestone 1 frontend). Enable once apps/web has a build. -------------
# FROM node:24-slim AS web
# WORKDIR /web
# RUN corepack enable
# COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
# RUN pnpm install --frozen-lockfile
# COPY apps/web/ ./
# COPY contract/ /contract/
# RUN pnpm build

# ---- api: resolve and install Python deps into /app/.venv -------------------------------
FROM ghcr.io/astral-sh/uv:0.9.5 AS uv
FROM python:${PYTHON_VERSION}-slim AS api
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY apps/api/README.md ./
COPY apps/api/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ---- runtime ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime
ARG UID=1000
ARG GID=1000
RUN groupadd --gid "${GID}" housebook \
 && useradd --uid "${UID}" --gid "${GID}" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin housebook \
 && mkdir -p /data && chown "${UID}:${GID}" /data
COPY --from=api /app/.venv /app/.venv
COPY contract/ /app/contract/
# COPY --from=web /web/dist /app/web
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOUSEBOOK_DATA_DIR=/data \
    HOUSEBOOK_CONTRACT_DIR=/app/contract \
    HOUSEBOOK_STATIC_DIR=/app/web \
    HOUSEBOOK_PORT=8000
USER ${UID}:${GID}
WORKDIR /app
VOLUME ["/data"]
EXPOSE 8000
# The slim image has no curl; readiness = first scan done and /data writable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('HOUSEBOOK_PORT', '8000')}/readyz\", timeout=4)"]
CMD ["housebook", "serve"]
