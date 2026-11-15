# Configuration

Settings for people who run Housebook: environment variables, the Docker image, login behind a
proxy, reverse proxies and offline use. To install it, start with the README's
[Install](../README.md#install) section.

With the install file ([deploy/compose.yaml](../deploy/compose.yaml)), the everyday settings
(address, port, user, time zone, role) go in `.env` next to it, as its comments explain. Any other
variable below goes under `environment:` in that file.

## The image

Images are on GitHub's registry for amd64 and arm64 (Raspberry Pi 4/5); `0.1` follows
the newest fixes of 0.1, `latest` the newest release ([CHANGELOG.md](../CHANGELOG.md)):

```sh
docker pull ghcr.io/deepblue597/housebook:0.1
```

The image runs as a non-root user (UID/GID 1000 by default; `--build-arg UID=… --build-arg GID=…`
to change, which compose does from `HB_UID`/`HB_GID`), works with a read-only root filesystem (only `/data` is written), and
has a `HEALTHCHECK` on `/readyz`. Mount a **directory** at `/data`, not a single file. Run
exactly one instance per data root (`replicas: 1`, `strategy: Recreate` on k3s).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HOUSEBOOK_DATA_DIR` | `/data` | Data root (contains `house.json`) |
| `HOUSEBOOK_NOTES_DIR` | `House` | Notes folder, relative to the data root (may be nested, e.g. `Notes/Home`). Only `*.md` here are items. Rejected at startup: `.` (the data root itself) and hidden/temporary names the scanner skips (`.hb`, `*~`, `*.tmp`, …) |
| `HOUSEBOOK_OBSIDIAN_VAULT` | – | Vault name; enables `obsidian://` links in item responses |
| `HOUSEBOOK_OBSIDIAN_VAULT_SUBPATH` | – | Path of the data root inside the vault, e.g. `Housebook` |
| `HOUSEBOOK_TZ` | `$TZ`, else `UTC` | Household time zone; decides "today" for statuses |
| `HOUSEBOOK_AUTH_MODE` | `none` | `none`, `proxy` or `oidc`: see [login.md](login.md) for which to choose and how to set each up |
| `HOUSEBOOK_ANON_ROLE` | `viewer` | Role for everyone in `none` mode; `editor` must be set explicitly |
| `HOUSEBOOK_TRUSTED_PROXIES` | – | Comma-separated IPs/CIDRs of the auth proxy. Required in `proxy` mode |
| `HOUSEBOOK_LOGOUT_URL` | `/oauth2/sign_out` | `proxy` mode: where "Log out" goes (the proxy's sign-out page) |
| `HOUSEBOOK_PUBLIC_URL`, `HOUSEBOOK_OIDC_*`, `HOUSEBOOK_SESSION_*` | – | `oidc` mode: the app's own login, see [login.md](login.md#settings) |
| `HOUSEBOOK_EDITOR_GROUP` | `housebook-editors` | Group (from `X-Forwarded-Groups`) that grants `editor`. A full path such as `/home/housebook-editors` matches exactly that group (**recommended**, stricter). A bare name matches that name at any depth (`/housebook-editors`, `/kids/housebook-editors`, …). Case-sensitive, like Keycloak group names |
| `HOUSEBOOK_WATCH` | `inotify` | How file changes made outside the app (Obsidian, Syncthing, a file manager) are noticed. `inotify`: native events (falls back to `poll` if they can't be set up). `poll`: a full rescan every `HOUSEBOOK_POLL_INTERVAL`; use it on NFS, SMB, 9p and Docker Desktop shares, which don't deliver events for changes made by other machines (a warning is logged at startup when the data folder is on one). `off`: only the periodic rescan |
| `HOUSEBOOK_POLL_INTERVAL` | `5` | Seconds between rescans with `HOUSEBOOK_WATCH=poll` (0.1–3600) |
| `HOUSEBOOK_RESCAN_INTERVAL` | `600` | Seconds between full rescans, whatever the watch mode (`0` disables). The watcher is for speed; this is the correctness path |
| `HOUSEBOOK_STATIC_DIR` | – (`/app/web` in Docker) | Built SPA to serve; any non-`/api` GET falls back to `index.html` |
| `HOUSEBOOK_CONTRACT_DIR` | repo `contract/` (`/app/contract` in Docker) | Where `catalog.json` is read from |
| `HOUSEBOOK_HOST` / `HOUSEBOOK_PORT` | `0.0.0.0` / `8000` | Listen address |
| `HOUSEBOOK_LOG_LEVEL` | `INFO` | JSON logs to stdout |

A variable set to an empty value counts as unset.

## Proxy auth (oauth2-proxy + Keycloak)

With `HOUSEBOOK_AUTH_MODE=proxy`, `X-Forwarded-User` and `X-Forwarded-Groups` are trusted only
when the TCP peer is in `HOUSEBOOK_TRUSTED_PROXIES`; any other request to `/api` gets `401`.
Set `HOUSEBOOK_EDITOR_GROUP` to the full Keycloak group path (e.g. `/home/housebook-editors`) so
that only that exact group grants editing; a bare name also matches same-named subgroups anywhere
in the tree. Matching is case-sensitive. Don't publish the container port; keep it on an internal network behind the proxy.
`/healthz` and `/readyz` need no auth; `/api/docs` and `/api/openapi.json` follow the same rule as
the rest of `/api`.

**Calendar feed.** Calendar apps can't log in, so `/api/calendar.ics` is opened with the private
code in its link instead. Let that one path through the proxy without a login, and only that path
(not `/api/calendar/link`, which needs one). oauth2-proxy: `--skip-auth-route='GET=^/api/calendar\.ics$'`;
Authelia: an access-control rule with `policy: bypass` for `^/api/calendar\.ics$`; Traefik
forward-auth or nginx `auth_request`: a separate route for that path without the auth middleware.
A person's link keeps working after they lose access through the proxy: turn it off in the app
(sign in as them) or delete their entry from `.housebook/calendar-links.json`. Google Calendar
fetches the feed from Google's servers, so it only works when Housebook is reachable from the
internet; Apple Calendar and Thunderbird fetch it from the device.

## Reverse proxy and SSE

`/api/events` is a long-lived stream. nginx: `proxy_buffering off; proxy_http_version 1.1;
proxy_read_timeout 1h;` (the app also sends `X-Accel-Buffering: no`); ingress-nginx: the
`proxy-buffering: "off"` and `proxy-read-timeout` annotations. Traefik streams fine; don't apply a
compress middleware to `text/event-stream`. Uploads are up to 25 MiB: raise the proxy's body limit (nginx defaults to 1 MB: `client_max_body_size
30m;`, ingress-nginx: `proxy-body-size`). Use HTTP/2 at the proxy: over HTTP/1.1 browsers allow
6 connections per host and every open tab holds one stream.

## Offline and the home screen

Once opened, the app keeps working without the server: a saved copy of the app and of the data
it last showed, read-only, with an "Offline, data from …" banner. That is when a QR sticker or
"where is the water valve?" matters most. It needs **HTTPS** (or `localhost`): browsers allow
service workers and their storage only there, so a plain `http://192.168.…` address gets no
offline copy. Add the app to the phone's home screen: iOS otherwise clears a site's storage after
about a week without use.

Behind a login proxy nothing extra is needed: when the proxy sends a page load to the login
provider and the provider can't be reached, the saved app opens with the saved data and a "Sign in
again" link. The app adds `?signin=1` to a page load that must reach the proxy (after a login
expired), so keep query strings in the proxy's redirect back (oauth2-proxy does).
