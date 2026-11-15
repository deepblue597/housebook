# Security

Housebook holds a household's notes, receipts and floor plan, and some people reach it from
outside their home network. Please report security problems privately, not in a public issue.

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability**.
Include what you found, how to reproduce it (the version or image tag, the login mode, the
request), and what an attacker gains. You'll get an answer as soon as we can; this is a small
volunteer project, so give it a few days. We'll agree with you on a fix and a date before
anything is published, and credit you unless you'd rather not be named.

## Supported versions

Fixes go into the newest minor version (the `ghcr.io/deepblue597/housebook:<major>.<minor>`
tag the install file uses) as a patch release. Upgrade to it: older versions don't get fixes.

## What counts

- Anything that lets someone read or change data they shouldn't: bypassing the login in `proxy`
  or `oidc` mode, a viewer changing things, reading files outside the data folder, script
  injection through notes, uploads or `house.json`.
- Weaknesses in the Docker image or the install file (`deploy/compose.yaml`).

Not a vulnerability: with `HOUSEBOOK_AUTH_MODE=none` (the install file's default) anyone who can
reach the app can use it. That mode is meant for this computer, a home network or a tailnet only
([docs/login.md](docs/login.md)); putting it on the internet without a login is a setup mistake.
