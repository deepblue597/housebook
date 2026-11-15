# Backups and restoring

Everything Housebook knows is in one folder, the **data folder** (`/data` in the container,
`HOUSEBOOK_DATA_DIR` otherwise). There is no database, so backing up Housebook means backing up
that folder, and restoring it means putting the folder back.

## What is in the data folder

| Path | What | Back up? |
|---|---|---|
| `house.json` | the floor plan: floors, rooms, doors and windows, where items are | **yes** |
| `House/` | one Markdown note per item, and a folder of attachments next to each (manuals, receipts, photos) | **yes** |
| `Textures/` | floors and wallpapers you uploaded | **yes** |
| `.housebook/history/` | the last 50 versions of `house.json`, and the original of every format upgrade | yes |
| `.housebook/trash/` | deleted items and attachments, kept for 90 days | yes |
| `.housebook/calendar-links.json` | fingerprints of everyone's calendar links (without it, each person makes a new link) | yes |
| `.housebook/session-key` | the key for login cookies (`oidc` mode only). It is a secret: anyone holding it can make a login for anyone. Without it, people just sign in again | your choice; keep it out of anything shared |
| `.housebook/lock`, `.housebook/uploads/` | the running server's lock and unfinished uploads | no |

If `HOUSEBOOK_NOTES_DIR` is set, your notes are in that folder instead of `House/`.

## Three ways to back up

### 1. With the backup tool you already use (recommended)

Back up the data folder on the host every night with restic, borg, Kopia, Duplicati, your NAS's
snapshot feature or whatever already backs up your other files, and keep several versions
(for example 7 daily, 4 weekly, 6 monthly). Housebook doesn't need to be stopped: it saves
every file by writing a new copy and renaming it over the old one, so a backup never catches a
half-written file.

```sh
# restic, nightly from cron; /srv/housebook is the folder mounted at /data
restic backup /srv/housebook --exclude /srv/housebook/.housebook/lock --exclude /srv/housebook/.housebook/uploads
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

Where is the folder? With compose, it is the left side of the `volumes:` line for `/data`. With
a named Docker volume, `docker volume inspect <name>` shows it under `Mountpoint` (back up that
path, or switch to a folder you choose: a bind mount is easier to back up).

**Syncthing, Nextcloud or Obsidian Sync are not backups.** They copy a mistake or a deletion to
every device within seconds. Use them alongside a real backup, not instead of one.

### 2. Download a backup from the app

Editors find **Download a backup (.zip)** in the ⋯ menu (or `GET /api/export`). The zip has
everything in the table marked "yes"; it leaves out the lock, unfinished uploads and the
session key. It is a good extra copy before an upgrade or a big rearrangement, and the easiest way
to move to another server. It holds receipts and serial numbers, so store it like any other
private document.

### 3. History in git (optional)

If you like seeing what changed when, a host cron job can commit the folder to a private git
repository: `cd /srv/housebook && git add -A && git commit -qm "nightly" || true`. Add a
`.gitignore` with `.housebook/lock`, `.housebook/uploads/` and `.housebook/session-key`.
Attachments make the repository grow; use git-lfs for them or keep a normal backup as well.
Housebook ignores the `.git` folder (and leaves it out of the zip).

## Restoring

1. **Stop Housebook** (`docker compose stop housebook`). Only one Housebook may use a data
   folder at a time.
2. **Put the folder back** into an empty folder, from your backup tool, or from a zip:

   ```sh
   mkdir /srv/housebook-restored
   unzip housebook-20261115-090000Z.zip -d /srv/housebook-restored
   ```

3. **Give it to the right user.** The container runs as UID/GID 1000 unless you changed it
   (`HB_UID`/`HB_GID`), and it must be able to write the folder:
   `sudo chown -R 1000:1000 /srv/housebook-restored`.
4. **Point Housebook at it** (the `volumes:` line in compose) and start it again.
5. **Check it:**
   - `curl -fsS http://127.0.0.1:8000/readyz` answers `{"status": "ready", ...}`;
   - the plan shows your floors and items, and a few items open with their attachments;
   - no new ⚠ problems in the top bar compared with before (it only shows when there are some);
   - with `oidc` login and no restored `session-key`, everyone signs in again (expected).

To get back one item instead of everything, copy just its note and attachment folder from the
backup into `House/` while Housebook runs; it notices the files within seconds. A deleted item
is also in `.housebook/trash/` for 90 days: move its folder's contents back into `House/`.

To undo a bad change to the plan, `.housebook/history/` has the last 50 versions of
`house.json`: stop Housebook, copy the one you want over `house.json`, and start it again.

## Test a restore once

A backup you have never restored is a hope, not a backup. Once, and after you change how you
back up, restore into a scratch folder and start a second Housebook on another port:

```sh
mkdir /tmp/restore-test && unzip housebook-*.zip -d /tmp/restore-test   # or restic restore …
docker run --rm -p 127.0.0.1:8001:8000 --user "$(id -u):$(id -g)" \
  -v /tmp/restore-test:/data ghcr.io/deepblue597/housebook:0.1
```

Open http://127.0.0.1:8001 and check it as in step 5, then stop it and delete the folder.
It is a separate copy, so it doesn't conflict with the Housebook you are running.

## Before an upgrade

Download a backup first. Upgrades never change your notes, but a new version may upgrade
`house.json` to a newer format on the first save. The original is kept in
`.housebook/history/house.v<n>.<time>.json`. If you go back to the older image, it opens the
newer file read-only (it shows everything but can't save); to edit with the old version again,
copy that original back over `house.json`, or restore the backup. The changelog says which
releases change the format.
