// Engine: the pure rules behind the first-run wizard (docs/release-plan.md
// "Onboarding (four screens)"): which code roots trip macOS folder
// permissions, what a custom agent id may be, and how probe output (repo
// scans, `--version`, `gh auth status`) maps to what the wizard shows.

import { basename, isAbsolute, join, resolve } from "node:path";
import type {
  ProtectedHomeFolder,
  ScannedRepository,
} from "../contracts/onboarding.js";
import type { RepositoryInfo } from "../contracts/workspace.js";

/** Home folders macOS guards per app; an unsigned build is re-prompted after every upgrade (R12a). */
export const PROTECTED_HOME_FOLDERS: readonly ProtectedHomeFolder[] = [
  "Documents",
  "Desktop",
  "Downloads",
];

/** Agent ids a custom CLI may never take (the built-in adapters). */
export const BUILTIN_AGENT_IDS: readonly string[] = ["pi", "claude-code"];

/** `~` / `~/x` → absolute under `home`; anything else resolved as-is. */
export function expandHome(path: string, home: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return resolve(home);
  if (trimmed.startsWith("~/")) return resolve(join(home, trimmed.slice(2)));
  return resolve(trimmed);
}

/**
 * The protected home folder `path` is (inside), if any. Compared
 * case-insensitively: the default macOS volume is case-insensitive, so
 * `~/documents/code` is the same guarded folder.
 */
export function protectedHomeFolder(
  path: string,
  home: string,
): ProtectedHomeFolder | undefined {
  if (!path.trim()) return undefined;
  const target = expandHome(path, home).toLowerCase();
  for (const folder of PROTECTED_HOME_FOLDERS) {
    const guarded = resolve(home, folder).toLowerCase();
    if (target === guarded || target.startsWith(`${guarded}/`)) return folder;
  }
  return undefined;
}

/**
 * Home-relative folders people usually keep checkouts in, most common
 * first. The first that exists is suggested as the repositories folder, so
 * existing repos are found and agent clones land next to them.
 */
export const CODE_ROOT_CANDIDATES: readonly string[] = [
  "Code",
  "code",
  "src",
  "Projects",
  "projects",
  "dev",
  "Developer",
  "repos",
  "git",
  "workspace",
];

/** {@link CODE_ROOT_CANDIDATES} as absolute paths under `home`, in order. */
export function codeRootCandidates(home: string): string[] {
  return CODE_ROOT_CANDIDATES.map((name) => resolve(home, name));
}

/** The repositories folder when no candidate exists: `~/harbormaster` (created on save). */
export function fallbackCodeRoot(home: string): string {
  return resolve(home, "harbormaster");
}

/**
 * Problems with a custom agent before it is written to `agents.custom[]`:
 * a lowercase id (letters, digits, `-`, `_`) that is not a built-in, a
 * label, and a command (a bare name or an absolute path). Empty = valid.
 */
export function customAgentProblems(agent: {
  id: string;
  label: string;
  command: string;
  args?: readonly string[];
}): string[] {
  const problems: string[] = [];
  const id = agent.id.trim();
  if (!id) problems.push("The agent needs an id.");
  else if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    problems.push(
      "The agent id may use only lowercase letters, digits, - and _.",
    );
  } else if (BUILTIN_AGENT_IDS.includes(id)) {
    problems.push(`"${id}" is a built-in agent; pick another id.`);
  }
  if (!agent.label.trim()) problems.push("The agent needs a label.");
  const command = agent.command.trim();
  if (!command) problems.push("The agent needs a command.");
  else if (command.includes("/") && !isAbsolute(command)) {
    problems.push("The command must be a bare name or an absolute path.");
  }
  if (agent.args?.some((arg) => typeof arg !== "string")) {
    problems.push("Arguments must be text.");
  }
  return problems;
}

/** The first version-looking token in a CLI's `--version` output (`2.1.3`, `v0.9.0-beta.1`). */
export function parseCliVersion(output: string): string | undefined {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(
    output,
  );
  return match?.[1];
}

/**
 * The active account in `gh auth status` output. Handles both formats:
 * `Logged in to github.com account alice (keyring)` (gh ≥ 2.40, one block
 * per account with `Active account: true|false`) and the older
 * `Logged in to github.com as alice (oauth_token)`.
 */
export function parseGhAuthStatus(
  output: string,
): { account: string; host: string } | undefined {
  const lines = output.split(/\r?\n/);
  let first: { account: string; host: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const match =
      /Logged in to (\S+) (?:account|as) ([A-Za-z0-9][A-Za-z0-9-]*)/.exec(
        lines[i] as string,
      );
    if (!match) continue;
    const found = { host: match[1] as string, account: match[2] as string };
    first ??= found;
    // The block's "Active account:" line follows within a few lines.
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const active = /Active account:\s*(true|false)/.exec(lines[j] as string);
      if (active) {
        if (active[1] === "true") return found;
        break;
      }
    }
  }
  return first;
}

/**
 * Discovered repositories → the wizard's list: one row per repository
 * identity (several checkouts of one remote show once, by the primary's
 * folder name), sorted by name.
 */
export function toScannedRepositories(
  repositories: readonly RepositoryInfo[],
): ScannedRepository[] {
  const seen = new Set<string>();
  const rows: ScannedRepository[] = [];
  for (const repo of repositories) {
    if (seen.has(repo.id)) continue;
    seen.add(repo.id);
    rows.push({ id: repo.id, name: basename(repo.root), root: repo.root });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
