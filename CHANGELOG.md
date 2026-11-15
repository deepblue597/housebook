# Changelog

What changed in each release of Housebook, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). How to cut a release: [docs/releasing.md](docs/releasing.md).

Before 1.0, a minor version (0.**x**.0) may change the data format; the app upgrades older
`house.json` files on the first save and opens newer ones read-only, so take a backup (⋯ menu,
"Download a backup") before upgrading.

## [Unreleased]

The first release. Everything below is new.

### Plan and views

- A 2D plan and a 3D view of every floor, a list of all items, search, and an item panel with
  the manual, warranty, quick help, maintenance log and attachments.
- "Home look": floor finishes (wood, tiles, stone, concrete, carpet) and wall paint or wallpaper
  per room, in 2D and 3D, including your own uploaded textures.
- Attention: what is overdue, due soon or out of warranty soon, and a calendar feed of checks
  and warranty ends for Google, Apple, Outlook or Thunderbird.
- Live updates: changes made in another tab, on another device or in Obsidian show up at once.

### Editing

- A layout editor for editors: draw rooms, place, move and rotate items, resize the house, add
  and reorder floors, doors and windows, with undo and redo.
- Edit an item's fields and notes in the app (Markdown, with a preview), upload photos, manuals
  and receipts (photos lose their location data; HEIC becomes JPEG), and delete items (kept in
  the trash for 90 days).
- First-run setup on an empty data folder.

### Emergencies and offline

- A printable emergency sheet: where the water valve, fuse box, gas valve and other critical
  items are, and what to do.
- QR stickers that open an item's page.
- Offline viewing: the app and the last known data stay readable without a connection, and it
  can be installed to a phone's home screen.

### Running it

- Login: none (home network or Tailscale only), a login proxy in front, or the app's own
  sign-in with Keycloak, Authentik or Authelia. See `docs/login.md`.
- "Download a backup (.zip)" in the ⋯ menu for editors, and a backup and restore guide
  (`docs/backup.md`).
- A Docker image for amd64 and arm64 at `ghcr.io/deepblue597/housebook`, and
  `deploy/compose.yaml` to install it with Docker Compose in a few commands (README, "Install").
