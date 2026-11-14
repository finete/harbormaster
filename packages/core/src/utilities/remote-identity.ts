// Utility: git remote URL → stable repository identity. Pure string work,
// shared by repository access (discovery, clone reuse) and the manager
// (matching a clone URL against already-known checkouts).

/**
 * Normalize an `origin` remote URL to a stable, comparable identity:
 * `git@github.com:org/repo.git`, `https://github.com/org/repo.git`, and
 * `https://user@github.com/org/repo` all normalize to `github.com/org/repo`.
 */
export function normalizeRemoteIdentity(remote: string): string {
  let value = remote
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "");
  const scp = value.match(/^[^@/]+@([^:]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  else
    value = value
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/^[^@/]+@/, "");
  return value.toLowerCase();
}
