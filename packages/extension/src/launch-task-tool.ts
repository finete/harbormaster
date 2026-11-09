// Pure logic behind the `harbormaster_launch_task` agent tool (see
// /docs/design-decisions.md "Launching tasks from an agent"'s "one primitive"): resolving the tool's plain-
// string `repository` parameter into the `LaunchTaskInput["repository"]`
// union core's `launchTask` expects, and the result text handed back to the
// calling agent. Kept free of the `pi` extension API and `@harbormaster/core`
// I/O so it is testable with plain fake `RepositoryInfo[]` arrays —
// `index.ts` is the only place that wires this against a real `pi.registerTool`
// and `core.commands.launchTask`.

import type {
  KnownLocation,
  LaunchTaskInput,
  RepositoryInfo,
} from "@harbormaster/core";

/** Recognizes a clone-URL-shaped `repository` value: a URL scheme, or scp-like/`.git`-suffixed git syntax. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function looksLikeCloneUrl(value: string): boolean {
  return (
    URL_SCHEME.test(value) || value.startsWith("git@") || value.endsWith(".git")
  );
}

/** Last path segment of a normalized repository id (e.g. `"repo"` from `"github.com/org/repo"`). */
export function repositoryShortName(id: string): string {
  const segments = id.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? id;
}

/**
 * Resolve the `harbormaster_launch_task` tool's plain-string `repository`
 * parameter against the repositories `listRepositories()` discovered:
 * `"none"` (case-insensitive) -> no repository; a clone-URL-shaped value ->
 * cloned by core; otherwise matched against known repository ids first
 * (exact), then unique short names, then registered non-git folders (by
 * path or unique folder name); an absolute path runs in that folder.
 * Unknown or ambiguous input throws a clear error listing the candidates,
 * instead of guessing.
 */
export function resolveLaunchRepository(
  input: string,
  repositories: readonly RepositoryInfo[],
  locations: readonly KnownLocation[] = [],
): LaunchTaskInput["repository"] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(
      'repository is required: use "none" for no repository, a discovered repository id or short name, or a git clone URL.',
    );
  }
  if (trimmed.toLowerCase() === "none") return { none: true };
  if (looksLikeCloneUrl(trimmed)) return { cloneUrl: trimmed };

  const byId = repositories.find((repo) => repo.id === trimmed);
  if (byId) return { repositoryId: byId.id };

  const byShortName = repositories.filter(
    (repo) => repositoryShortName(repo.id) === trimmed,
  );
  const [uniqueMatch] = byShortName;
  if (byShortName.length === 1 && uniqueMatch) {
    return { repositoryId: uniqueMatch.id };
  }
  if (byShortName.length > 1) {
    throw new Error(
      `Ambiguous repository "${trimmed}": matches ${byShortName
        .map((repo) => repo.id)
        .join(", ")}. Use the full repository id instead of the short name.`,
    );
  }

  const folders = locations.filter((location) => !location.repositoryId);
  const byPath = folders.find((location) => location.path === trimmed);
  if (byPath) return { folderPath: byPath.path };
  const byName = folders.filter((location) => location.name === trimmed);
  const [uniqueFolder] = byName;
  if (byName.length === 1 && uniqueFolder) {
    return { folderPath: uniqueFolder.path };
  }
  if (byName.length > 1) {
    throw new Error(
      `Ambiguous folder "${trimmed}": matches ${byName
        .map((location) => location.path)
        .join(", ")}. Use the full folder path instead.`,
    );
  }
  // An absolute path: core registers it and resolves git vs. plain folder.
  if (trimmed.startsWith("/")) return { folderPath: trimmed };

  const known = [
    ...repositories.map((repo) => repo.id),
    ...folders.map((location) => location.path),
  ];
  throw new Error(
    known.length
      ? `Unknown repository "${trimmed}". Known repositories and folders: ${known.join(", ")}. Use "none" for no repository, or a git clone URL to clone a new one.`
      : `Unknown repository "${trimmed}". No repositories are discovered under the configured code root. Use "none" for no repository, or a git clone URL to clone a new one.`,
  );
}

/** Human-readable label for the resolved repository, for the tool's result text. */
export function launchRepositoryLabel(
  repository: LaunchTaskInput["repository"],
): string {
  if ("none" in repository) return "no repository";
  if ("cloneUrl" in repository) return repository.cloneUrl;
  if ("folderPath" in repository) return repository.folderPath;
  return repository.repositoryId;
}

export interface LaunchResultInput {
  title: string;
  id: string;
  relation: "child" | "standalone";
  repositoryLabel: string;
}

/**
 * Result text handed back to the launching agent: names the task, states
 * the relation and repository, and is explicit that the task is QUEUED and
 * only starts once the Harbormaster app is running — the agent must never
 * assume the work already began (see /docs/design-decisions.md "Launching tasks from an agent": "Launching
 * while the app is closed").
 */
export function buildLaunchResultText(input: LaunchResultInput): string {
  const followUp =
    input.relation === "child"
      ? " Use harbormaster_subtask_status to check on it."
      : "";
  return (
    `Launched "${input.title}" (${input.id}) as a ${input.relation} task in ${input.repositoryLabel}. ` +
    `QUEUED — it has not started yet; it starts running in the background once the Harbormaster app is running.${followUp}`
  );
}
