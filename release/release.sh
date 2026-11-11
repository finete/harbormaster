#!/usr/bin/env bash
# Cuts a Harbormaster release (release plan R12, "Build and distribution").
#
#   release/release.sh <version> [--tap-dir DIR] [--dry-run]
#   release/release.sh cask <version> <sha256> <file>   # rewrite one cask file
#
# Steps:
#   1. bump "version" (and the @harbormaster/* workspace dependency pins) in
#      every package.json, sync package-lock.json
#   2. npm run dist (core, app, electron-builder zip + latest-mac.yml)
#   3. sha256 of the zip; rewrite release/homebrew/Casks/harbormaster.rb
#   4. commit "release: v<version>", tag v<version>, push main + tag
#   5. create the GitHub release with the zip, blockmap and latest-mac.yml
#      (as finete, per AGENTS.md "Identity")
#   6. copy the cask into the finete/homebrew-tap checkout, commit, push
#
# The tap checkout defaults to a sibling of this repo (../homebrew-tap);
# override with --tap-dir or HARBORMASTER_TAP_DIR. --dry-run prints every
# command that would change files, git or GitHub, and runs none of them.
# One-time setup (tap repo creation) is in release/README.md.
set -euo pipefail

REPO_SLUG="finete/harbormaster"
GH_USER="finete"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASK_TEMPLATE="$ROOT/release/homebrew/Casks/harbormaster.rb"
DIST_DIR="$ROOT/packages/app/dist"

die() {
  echo "release: $*" >&2
  exit 1
}

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
}

# Rewrites the `version` and `sha256` lines of a cask file in place.
render_cask() {
  local version="$1" sha="$2" file="$3"
  is_semver "$version" || die "not a semver version: $version"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "not a sha256: $sha"
  [[ -f "$file" ]] || die "no cask file at $file"
  local tmp
  tmp="$(mktemp)"
  sed -E \
    -e "s/^(  version )\"[^\"]*\"/\\1\"$version\"/" \
    -e "s/^(  sha256 )\"[^\"]*\"/\\1\"$sha\"/" \
    "$file" >"$tmp"
  grep -q "^  version \"$version\"$" "$tmp" || die "could not set version in $file"
  grep -q "^  sha256 \"$sha\"$" "$tmp" || die "could not set sha256 in $file"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

if [[ "${1:-}" == "cask" ]]; then
  [[ $# -eq 4 ]] || usage 1
  render_cask "$2" "$3" "$4"
  exit 0
fi

VERSION=""
DRY_RUN=0
TAP_DIR="${HARBORMASTER_TAP_DIR:-$(dirname "$ROOT")/homebrew-tap}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tap-dir)
      [[ $# -ge 2 ]] || usage 1
      TAP_DIR="$2"
      shift
      ;;
    -h | --help) usage 0 ;;
    -*) usage 1 ;;
    *)
      [[ -z "$VERSION" ]] || usage 1
      VERSION="${1#v}"
      ;;
  esac
  shift
done
[[ -n "$VERSION" ]] || usage 1
is_semver "$VERSION" || die "not a semver version: $VERSION"

TAG="v$VERSION"
ZIP="$DIST_DIR/Harbormaster-$VERSION-arm64-mac.zip"

# run CMD...: executes, or only prints under --dry-run.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# gh as finete, never whatever account is active (AGENTS.md "Identity").
gh_finete() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run] GH_TOKEN="$(gh auth token --user %s)" gh' "$GH_USER"
    printf ' %q' "$@"
    printf '\n'
  else
    GH_TOKEN="$(gh auth token --user "$GH_USER")" gh "$@"
  fi
}

bump_versions() {
  node --input-type=module - "$ROOT" "$VERSION" <<'NODE'
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [root, version] = process.argv.slice(2);
const files = [join(root, "package.json")];
for (const name of readdirSync(join(root, "packages"))) {
  const file = join(root, "packages", name, "package.json");
  if (existsSync(file)) files.push(file);
}
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep.startsWith("@harbormaster/")) pkg[field][dep] = version;
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`release: ${file} -> ${version}`);
}
NODE
}

# --- preflight (read-only) ---------------------------------------------------
cd "$ROOT"
command -v gh >/dev/null || die "gh is not installed"
command -v shasum >/dev/null || die "shasum is not available"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || die "releases are cut from main"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
[[ -d "$TAP_DIR/.git" ]] || die "no homebrew-tap checkout at $TAP_DIR (see release/README.md)"
if [[ $DRY_RUN -eq 0 ]]; then
  gh auth token --user "$GH_USER" >/dev/null || die "gh has no token for $GH_USER (gh auth login)"
fi
echo "release: $TAG  (tap: $TAP_DIR${DRY_RUN:+, dry-run=$DRY_RUN})"

# --- 1. bump -------------------------------------------------------------------
run bump_versions
run npm install --package-lock-only --ignore-scripts --no-audit --no-fund

# --- 2. build ------------------------------------------------------------------
run npm run dist
if [[ $DRY_RUN -eq 1 ]]; then
  SHA="<sha256 of $(basename "$ZIP")>"
else
  [[ -f "$ZIP" ]] || die "build did not produce $ZIP"
  [[ -f "$DIST_DIR/latest-mac.yml" ]] || die "build did not produce latest-mac.yml"
  SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
fi
echo "release: sha256 $SHA"

# --- 3. cask in this repo ------------------------------------------------------
run render_cask "$VERSION" "$SHA" "$CASK_TEMPLATE"

# --- 4. commit, tag, push ------------------------------------------------------
run git add -A package.json package-lock.json packages/*/package.json "$CASK_TEMPLATE"
run git commit -m "release: $TAG"
run git tag -a "$TAG" -m "Harbormaster $TAG"
run git push origin main
run git push origin "$TAG"

# --- 5. GitHub release ---------------------------------------------------------
gh_finete release create "$TAG" \
  "$ZIP" "$ZIP.blockmap" "$DIST_DIR/latest-mac.yml" \
  --repo "$REPO_SLUG" \
  --title "Harbormaster $TAG" \
  --generate-notes

# --- 6. tap --------------------------------------------------------------------
run git -C "$TAP_DIR" pull --ff-only
run mkdir -p "$TAP_DIR/Casks"
run cp "$CASK_TEMPLATE" "$TAP_DIR/Casks/harbormaster.rb"
run git -C "$TAP_DIR" add Casks/harbormaster.rb
run git -C "$TAP_DIR" commit -m "harbormaster $VERSION"
run git -C "$TAP_DIR" push origin HEAD

echo "release: done. Users upgrade with: brew update && brew upgrade --cask harbormaster"
