# Logging in

Housebook holds a household's serial numbers, receipts, warranty dates and the layout of the
home. Decide who can reach it before deciding how they log in.

| Mode | Who it suits | Login | Roles |
|---|---|---|---|
| `none` | One person or one household, on the home network or Tailscale | none | everyone gets `HOUSEBOOK_ANON_ROLE` |
| `proxy` | You already run oauth2-proxy, Authelia or Authentik forward auth | your proxy | from the proxy's groups header |
| `oidc` | You have Keycloak, Authentik or Authelia and want no extra proxy | Housebook itself | from the provider's groups |

Every mode needs a reverse proxy for HTTPS if people open Housebook from phones: browsers only
keep the offline copy (and allow installing to the home screen) over HTTPS or on `localhost`.

## `none`: no login, reachable only where it should be

Anyone who can open the address can read everything, and with `HOUSEBOOK_ANON_ROLE=editor` also
change and delete it. That is fine when "anyone who can open it" means the people in the house:

- **Home network:** publish the port on the LAN only, never forward it on the router.
- **Tailscale (or WireGuard):** keep the port off the LAN entirely and reach it through the
  tailnet; `tailscale serve` adds HTTPS with a real certificate.

**Never expose `none` to the internet**, not even "just for a while" or on an unusual port:
scanners find open ports within hours, and the data is a map of the home with the values of
what is in it.

```yaml
environment:
  HOUSEBOOK_AUTH_MODE: none
  HOUSEBOOK_ANON_ROLE: editor   # or leave the default `viewer` and edit the files directly
ports:
  - "100.64.0.10:8000:8000"     # the machine's Tailscale address, not 0.0.0.0
```

Nobody is shown as signed in and there is no "Log out".

## `proxy`: a login proxy in front

The proxy signs people in and passes `X-Forwarded-User` and `X-Forwarded-Groups`. Housebook
trusts them only from the addresses in `HOUSEBOOK_TRUSTED_PROXIES`, so keep the container port
on an internal network the proxy shares and don't publish it. See the README's "Proxy auth"
section for the details (editor group, the calendar feed's bypass).

```yaml
environment:
  HOUSEBOOK_AUTH_MODE: proxy
  HOUSEBOOK_TRUSTED_PROXIES: 172.20.0.0/16           # the proxy's Docker network
  HOUSEBOOK_EDITOR_GROUP: /home/housebook-editors    # full group path: that group only
  HOUSEBOOK_LOGOUT_URL: /oauth2/sign_out             # the default (oauth2-proxy)
```

"Log out" in the ⋯ menu goes to `HOUSEBOOK_LOGOUT_URL`. With Authelia, set it to the portal's
logout, e.g. `https://auth.example.com/logout?rd=https://house.example/`; with Authentik's
forward auth, `/outpost.goauthentik.io/sign_out`.

## `oidc`: Housebook signs people in itself

Housebook sends people to the provider's login page and back (authorization code flow with
PKCE), checks the ID token against the provider's published keys, and keeps them signed in with
a cookie for `HOUSEBOOK_SESSION_DAYS` (30 by default; long sessions keep people using it on
their phones). No proxy is needed for the login, though you still want one for HTTPS.

```yaml
environment:
  HOUSEBOOK_AUTH_MODE: oidc
  HOUSEBOOK_PUBLIC_URL: https://house.example        # the address people open
  HOUSEBOOK_OIDC_ISSUER: https://sso.example/realms/home
  HOUSEBOOK_OIDC_CLIENT_ID: housebook
  HOUSEBOOK_OIDC_CLIENT_SECRET_FILE: /run/secrets/housebook_oidc   # or HOUSEBOOK_OIDC_CLIENT_SECRET
  HOUSEBOOK_EDITOR_GROUP: /home/housebook-editors
secrets:
  - housebook_oidc
```

In the provider, create a client (Keycloak: a client; Authentik: an OAuth2/OpenID provider and
application; Authelia: an entry under `identity_providers.oidc.clients`) with:

- **Redirect URI:** `https://house.example/api/auth/callback`
- **Post-logout redirect URI:** `https://house.example/` (so "Log out" can end the provider's
  session too and come back)
- **Confidential** with a client secret (client authentication `client_secret_basic`), or
  **public** with PKCE and no secret (leave `HOUSEBOOK_OIDC_CLIENT_SECRET` unset).
- **Groups** in the ID token or from userinfo, under the claim `groups` (change it with
  `HOUSEBOOK_OIDC_GROUPS_CLAIM`):
  - Keycloak: add a "Group Membership" mapper to the client (full group path on or off, to match
    `HOUSEBOOK_EDITOR_GROUP`).
  - Authentik: groups are in the `profile` scope by default.
  - Authelia: add `groups` to the client's scopes and to `HOUSEBOOK_OIDC_SCOPES`
    (`openid profile email groups`).

Who someone is comes from `preferred_username` (then `email`, then `sub`; change it with
`HOUSEBOOK_OIDC_USER_CLAIM`); the ⋯ menu shows their `name`. The groups are read when they sign
in: someone added to or removed from the editor group gets the new role the next time they sign
in, and so does everyone after `HOUSEBOOK_EDITOR_GROUP` changes. To sign everyone out at once,
delete `.housebook/session-key` in the data folder (or change `HOUSEBOOK_SESSION_SECRET`) and
restart.

**Session key.** Cookies are signed with `HOUSEBOOK_SESSION_SECRET` if set, else with a random
key Housebook creates in `.housebook/session-key` (readable only by its user). Keep it out of
anything you share; anyone with it can sign cookies for any user and role. If the data folder is
read-only, set `HOUSEBOOK_SESSION_SECRET`, or everyone is signed out on every restart.

**When the provider is down.** Signing in shows "Can’t reach the login provider" with a "Try
again" link. People already signed in keep working until their session ends, and a phone that
has opened Housebook before still shows the last data offline (D47).

**Behind a proxy for HTTPS only.** Pass the `Host` the browser used and don't strip cookies.
`/api/auth/*` must reach Housebook unchanged; nothing else is needed. The app's own files
(scripts, styles, icons, the service worker) are served without a login: they contain no data.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `HOUSEBOOK_PUBLIC_URL` | – | Required. The address people open, without a path; the redirect URI is this + `/api/auth/callback`. Cookies are `Secure` when it is `https` |
| `HOUSEBOOK_OIDC_ISSUER` | – | Required. The provider's issuer URL (its discovery document is at `<issuer>/.well-known/openid-configuration`) |
| `HOUSEBOOK_OIDC_CLIENT_ID` | – | Required |
| `HOUSEBOOK_OIDC_CLIENT_SECRET` / `_FILE` | – | The client secret, or a file holding it (Docker secrets). Unset: a public client |
| `HOUSEBOOK_OIDC_SCOPES` | `openid profile email` | Must include `openid` |
| `HOUSEBOOK_OIDC_USER_CLAIM` | `preferred_username` | Who someone is (calendar links are per user) |
| `HOUSEBOOK_OIDC_GROUPS_CLAIM` | `groups` | Where the groups are; read from userinfo when the ID token lacks it |
| `HOUSEBOOK_EDITOR_GROUP` | `housebook-editors` | As in `proxy` mode |
| `HOUSEBOOK_SESSION_DAYS` | `30` | How long a sign-in lasts |
| `HOUSEBOOK_SESSION_SECRET` / `_FILE` | – | Key for the session cookies; unset: `.housebook/session-key` |
