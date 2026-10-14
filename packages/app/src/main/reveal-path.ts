// Allowlist for the renderer's `shell:revealInFolder` IPC (see index.ts).
// Mirrors external-url.ts's host allowlist: the renderer is sandboxed with
// no Node/fs access, so "Reveal in Finder" has to round-trip through main,
// and main must never hand an arbitrary renderer-supplied path to
// `shell.showItemInFolder` (path traversal into the user's home directory,
// `/etc`, ...). Only a path that resolves *inside* one of the configured
// root directories (the discovered-repositories `codeRoot`, or this app's
// own state dir "-" where worktrees and session files live) is allowed.

import { resolve, sep } from "node:path";

/** True once `path` resolves to `root` itself, or somewhere strictly inside it. */
function isWithin(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(
    normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep,
  );
}

/**
 * Whether `path` is safe to hand to `shell.showItemInFolder`: a non-empty
 * string that resolves inside one of `allowedRoots` (empty/blank roots are
 * ignored, so a not-yet-configured `codeRoot` never widens the allowlist to
 * "everything").
 */
export function isAllowedRevealPath(
  path: unknown,
  allowedRoots: readonly (string | undefined)[],
): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  const roots = allowedRoots.filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  return roots.some((root) => isWithin(root, path));
}
