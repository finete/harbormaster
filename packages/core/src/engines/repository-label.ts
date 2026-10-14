// Engine: pure display-label logic for a RepositoryInfo, ported from
// pi-home's presentation picker (src/presentation/flows.ts), which renders
// `"${repo.name} — ${repo.checkouts.length} checkout(s)"`. Harbormaster has
// no separate `name` field (RepositoryInfo.id already doubles as the
// user-facing label, e.g. "github.com/arnac-io/arnac"), so this only adds
// the checkout-count suffix, and only when there is more than one checkout
// to disambiguate.

import type { RepositoryInfo } from "../contracts/workspace.js";

/**
 * `"github.com/arnac-io/arnac"` for a single-checkout repository, or
 * `"github.com/arnac-io/arnac — 3 checkouts"` when several checkouts of the
 * same identity were discovered under the code root.
 */
export function repositoryLabel(repo: RepositoryInfo): string {
  const count = repo.checkouts.length;
  if (count <= 1) return repo.id;
  return `${repo.id} — ${count} checkouts`;
}
