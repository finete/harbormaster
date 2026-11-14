// Pure display-label rule for the New Task repository picker, mirroring
// @harbormaster/core's `engines/repository-label.ts` (not imported directly:
// the renderer has no Node access, and that module type-only re-exports
// from the already-Node-dependent core package — see preload/api.ts's
// "only plain data shapes cross the bridge" boundary comment). Ported in
// spirit from pi-home's presentation picker
// (`"${repo.name} — ${repo.checkouts.length} checkout(s)"`); Harbormaster
// has no separate `name` field, so `RepositoryInfo.id` (already the
// user-facing label, e.g. "github.com/arnac-io/arnac") doubles for it.
import type { RepositoryInfo } from "../../../preload/api";

/**
 * `"github.com/arnac-io/arnac"` for a single-checkout repository, or
 * `"github.com/arnac-io/arnac — 3 checkouts"` when several checkouts of the
 * same identity were discovered under the code root.
 */
export function repositoryLabel(
  repo: Pick<RepositoryInfo, "id" | "checkouts">,
): string {
  const count = repo.checkouts.length;
  if (count <= 1) return repo.id;
  return `${repo.id} — ${count} checkouts`;
}

/** Short-name label for repository-less (scratch) tasks; also their sidebar group label. */
export const SCRATCH_REPO_LABEL = "scratch";

/**
 * A task's short repository name — the last path segment of its
 * `repositoryId` ("github.com/org/repo" -> "repo"), or "scratch" when it
 * has none. The one renderer-side copy of core's `repoShortName`
 * (engines/board-grouping.ts): the sidebar's repo groups and every card's
 * repo chip (TaskCard / SidebarTaskRow) all read it from here.
 */
export function taskRepoLabel(task: {
  repositoryId?: string | undefined;
}): string {
  const id = task.repositoryId?.trim();
  if (!id) return SCRATCH_REPO_LABEL;
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? id;
}
