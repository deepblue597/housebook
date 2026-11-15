"""Housebook backend."""

from importlib.metadata import PackageNotFoundError, version

try:
    # One place for the version: pyproject.toml (and apps/web/package.json, checked on release, D50).
    __version__ = version("housebook-api")
except PackageNotFoundError:  # running from a source tree that was never installed
    __version__ = "0+unknown"
