# Releasing

A release is a version tag on `main`. Pushing the tag runs `.github/workflows/release.yml`, which
publishes the Docker image to `ghcr.io/deepblue597/housebook` (amd64 and arm64) and a GitHub
release whose text is that version's section of `CHANGELOG.md` (D50).

## Versions

`major.minor.patch` ([Semantic Versioning](https://semver.org/)). Before 1.0:

- **minor** (0.2.0): new features, and any change to the data format (`house.json`
  `schemaVersion`, note frontmatter, the data folder layout) or to a setting;
- **patch** (0.1.1): fixes only, no format change, safe to roll back.

Image tags: `0.1.0` (exactly that release), `0.1` (the newest patch of 0.1, what most people
should use) and `latest`. From 1.0 on there is also `1`.

## Keeping the changelog

Every pull request that changes something a household would notice adds a line under
`## [Unreleased]` in `CHANGELOG.md`, in words for people who run Housebook, not for developers
("Furniture in the 3D view", not "Add FurnitureLayer component"). Use the headings already there
or *Added*, *Changed*, *Fixed*, *Removed*. Format changes and anything people must do when
upgrading go first, in bold.

## Cutting a release

1. On a branch (`chore/release-0.2.0`):
   - in `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.2.0] - 2027-01-10` (today) and add a
     new empty `## [Unreleased]` above it;
   - set the version in `apps/api/pyproject.toml` and `apps/web/package.json`, then run
     `cd apps/api && uv lock` (the lock file records the project's version too);
   - check: `python3 -I scripts/release-notes.py v0.2.0` prints the notes.
2. Open the pull request, let CI pass, merge.
3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.2.0 -m "Housebook 0.2.0"
   git push origin v0.2.0
   ```

4. Watch the *Release* workflow in the Actions tab (about 15 minutes: the arm64 image is built
   under emulation). It refuses a tag that isn't on `main`, or whose version doesn't match
   both files and a dated changelog section, before anything is published.

**First release only:** packages on ghcr.io start out private. After the first run, open the
package (the repository's *Packages* box → *housebook* → *Package settings*) and set its
visibility to public, so `docker pull` works without a login.

## When something goes wrong

- **The workflow failed before the image was pushed** (a version mismatch, say): delete the tag
  (`git push --delete origin v0.2.0 && git tag -d v0.2.0`), fix on a branch, merge, tag again.
- **A broken release is out:** don't move or reuse its tag (people may have pulled it). Fix it
  and release the next patch (0.2.1); the `0.2` and `latest` tags then point to the fix. Add a
  line to the broken version's changelog section saying what was wrong.
