# Releasing Harbormaster

Harbormaster ships as an unsigned Apple Silicon build: an electron-builder
zip attached to a GitHub release of `finete/harbormaster`, installed and
upgraded only through the Homebrew cask in `finete/homebrew-tap` (release
plan R12). The app checks GitHub Releases on startup and every 6 hours and
shows `brew upgrade --cask harbormaster` when a newer version exists.

Everything here acts as the `finete` GitHub account and nobody else (see
`AGENTS.md`, "Identity"): every `gh` call is prefixed with
`GH_TOKEN="$(gh auth token --user finete)"`.

## What a build contains

`npm run dist` (repo root) builds `@harbormaster/core`, builds the app with
electron-vite, bundles the `harbormaster` CLI
(`packages/app/scripts/bundle-cli.mjs`) and runs electron-builder with
`packages/app/electron-builder.yml`. Output in `packages/app/dist/`:

| File | Purpose |
|---|---|
| `Harbormaster-<version>-arm64-mac.zip` | The release asset the cask downloads |
| `Harbormaster-<version>-arm64-mac.zip.blockmap` | Differential-update data for a future electron-updater |
| `latest-mac.yml` | Update feed for a future electron-updater |
| `mac-arm64/Harbormaster.app` | The unpacked app (handy for a local launch check) |

The app bundle carries the CLI at
`Harbormaster.app/Contents/Resources/bin/harbormaster`, a shell launcher that
runs the bundled CLI with the app's own Electron in Node mode; the cask's
`binary` stanza links it onto the PATH as `harbormaster`.

The build is not signed with a Developer ID and not notarized. An
`afterPack` hook ad-hoc signs the bundle (so it is not reported as
"damaged"), and the cask clears the quarantine flag after install. Moving
to a signed + auto-updating build later is a config flip: set
`mac.identity` and `mac.notarize` in `electron-builder.yml`, drop the
`afterPack` hook, and add electron-updater (the `publish: github` config
already produces `latest-mac.yml`).

## One-time setup

1. Create the tap repository (once):

   ```sh
   GH_TOKEN="$(gh auth token --user finete)" gh repo create finete/homebrew-tap \
     --public --description "Homebrew tap for Harbormaster" --add-readme
   ```

   Homebrew maps `brew install --cask finete/tap/harbormaster` to the repo
   `finete/homebrew-tap`, file `Casks/harbormaster.rb`.

2. Clone it next to this repository (the release script's default tap path
   is `../homebrew-tap`; override with `--tap-dir` or
   `HARBORMASTER_TAP_DIR`), with the same identity pinning as this repo:

   ```sh
   cd ..
   git clone https://finete@github.com/finete/homebrew-tap.git
   cd homebrew-tap
   git config user.name finete
   git config user.email 34818222+finete@users.noreply.github.com
   mkdir -p Casks
   ```

3. Make sure `gh auth token --user finete` prints a token (`gh auth login`
   as finete otherwise).

## Cutting a release

From a clean `main`:

```sh
release/release.sh 0.1.0 --dry-run   # prints every mutating command
release/release.sh 0.1.0
```

The script bumps `version` in every `package.json` (and the
`@harbormaster/*` workspace pins), syncs `package-lock.json`, runs
`npm run dist`, writes the zip's sha256 into
`release/homebrew/Casks/harbormaster.rb`, commits `release: v0.1.0`, tags
`v0.1.0`, pushes, creates the GitHub release with the zip, blockmap and
`latest-mac.yml`, then copies the cask into the tap checkout and pushes it.

If a step fails after the tag is pushed, fix the cause and finish by hand;
`release/release.sh cask <version> <sha256> <file>` rewrites a cask's
`version` and `sha256` lines on their own.

## Checking a release

On a Mac that never had Harbormaster:

```sh
brew install --cask finete/tap/harbormaster
harbormaster --help
open -a Harbormaster
```

Current Homebrew refuses casks from taps the user has not trusted; a
fully-qualified `brew install --cask finete/tap/harbormaster` trusts the cask
as part of the install, so no separate `brew trust` step is needed.

After the next release, the running app shows the upgrade banner;
`brew upgrade --cask harbormaster` installs it.
