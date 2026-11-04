"""CLI: `housebook serve` (default) and `housebook schema`."""

import argparse
import json
import sys
from pathlib import Path

from housebook.config import ConfigError, Settings


def _serve() -> int:
    import uvicorn

    from housebook.api.app import create_app
    from housebook.log import setup_logging

    try:
        settings = Settings.from_env()
    except ConfigError as e:
        print(f"housebook: configuration error: {e}", file=sys.stderr)
        return 2
    setup_logging(settings.log_level)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        workers=1,  # one process per data root (DESIGN 15.5)
        proxy_headers=False,  # keep request.client = real peer for HOUSEBOOK_TRUSTED_PROXIES
        log_config=None,
        server_header=False,
    )
    return 0


def _schema(out: str | None) -> int:
    from housebook.domain.house import json_schema

    text = json.dumps(json_schema(), indent=2, ensure_ascii=False) + "\n"
    if out:
        Path(out).write_text(text, encoding="utf-8")
        print(f"wrote {out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="housebook")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("serve", help="run the server (default)")
    p_schema = sub.add_parser("schema", help="print the house.json JSON Schema")
    p_schema.add_argument("--out", help="write to this file instead of stdout")
    args = parser.parse_args(argv)
    if args.cmd == "schema":
        return _schema(args.out)
    return _serve()


if __name__ == "__main__":
    raise SystemExit(main())
