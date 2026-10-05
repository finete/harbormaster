// Engine: stateless task-workspace naming rules. Shared by the Manager (and
// any future mover/automation that needs to predict a branch name without
// creating one) — no I/O, no session state. Slug/branch derivation ported in
// spirit from pi-home's src/engines/title.ts (`slugify`/`taskBranch`),
// reshaped to Harbormaster's "prefix + slug + first 6 id chars" scheme so a
// branch is derivable from (title, id, prefix) alone, before any git call.

/** Lowercase, hyphenated, git-ref-safe slug of a task title (e.g. for branch names). */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

/**
 * Derive this task's branch name: `<branchPrefix><slug(title)>-<first 6 id
 * chars>`. `branchPrefix` is expected pre-normalized (trailing `/`, or
 * empty) by `JsonConfigAccess`.
 */
export function deriveTaskBranch(
  title: string,
  taskId: string,
  branchPrefix: string,
): string {
  const shortId = taskId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 6)
    .toLowerCase();
  return `${branchPrefix}${slugify(title)}-${shortId}`;
}
