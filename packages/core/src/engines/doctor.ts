// Engine: the pure decisions behind `harbormaster doctor` (CLI, the app's
// Setup screen "Check setup", the diagnostics bundle's doctor.json): how a
// probe's raw facts map to ok / warn / fail / skip, the thresholds, the
// display order, and the plain-text renderings. No I/O here; the probes are
// `EnvironmentProbeAccess`, the sequencing is `manager/doctor-runtime.ts`.

import { delimiter, resolve } from "node:path";
import type { OrphanWorktreeReport } from "../contracts/commands.js";
import {
  DOCTOR_PROBE_TIMEOUT_MS,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  type PathFacts,
  type PiExtensionFacts,
  type RemoteProbe,
  type ToolSocketFacts,
} from "../contracts/doctor.js";
import type { ProbeOutcome } from "../contracts/onboarding.js";
import type { RuleFile } from "../contracts/rules.js";
import {
  comparePiExtension,
  readExtensionVersion,
} from "../utilities/pi-extension.js";
import { parseCliVersion } from "./onboarding.js";

/** Limit for the orphan-worktree scan (it sizes every orphan with `du`). */
export const DOCTOR_SCAN_TIMEOUT_MS = 10_000;
/** Free space at the state dir below which `disk.free` fails. */
export const DISK_FAIL_BYTES = 1024 ** 3;
/** Free space at the state dir below which `disk.free` warns. */
export const DISK_WARN_BYTES = 5 * 1024 ** 3;

/** Display order of the check groups. */
export const DOCTOR_GROUPS: readonly string[] = [
  "tools",
  "agents",
  "state",
  "repos",
  "worktrees",
  "disk",
  "socket",
  "path",
];

const GROUP_TITLES: Record<string, string> = {
  tools: "Tools",
  agents: "Agents",
  state: "State files",
  repos: "Repositories",
  worktrees: "Worktrees",
  disk: "Disk",
  socket: "Tool socket",
  path: "PATH",
};

/** A group's display title (`repos` → `Repositories`). */
export function doctorGroupTitle(group: string): string {
  return GROUP_TITLES[group] ?? group;
}

/** The status prefix the CLI prints: `✓ ! ✗ -`. */
export const DOCTOR_STATUS_SYMBOLS: Record<DoctorStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  skip: "-",
};

function check(
  id: string,
  status: DoctorStatus,
  summary: string,
  extra: { detail?: string | undefined; remediation?: string | undefined } = {},
): DoctorCheck {
  return {
    group: id.split(".")[0] as string,
    id,
    status,
    summary,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.remediation ? { remediation: extra.remediation } : {}),
  };
}

/** A check whose probe could not run (timed out, threw, nothing to check). */
export function skippedCheck(id: string, reason: string): DoctorCheck {
  return check(id, "skip", reason);
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/** At most `max` lines, then `… N more`. */
function capLines(lines: readonly string[], max: number): string {
  if (lines.length <= max) return lines.join("\n");
  return [...lines.slice(0, max), `… ${lines.length - max} more`].join("\n");
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** Facts for a CLI `--version` check (`tools.git`, `agents.pi`, …). */
export interface CommandCheckInput {
  id: string;
  /** Display name (`git`, `Pi`). */
  label: string;
  /** The command probed (a bare name or a path). */
  command: string;
  /** Where it resolves on PATH, when it does. */
  resolved?: string | undefined;
  outcome: ProbeOutcome;
  /** Status when the command is missing. */
  whenMissing: "fail" | "warn";
  /** How to install it. */
  install: string;
}

/** A command on PATH with a working `--version`: ok with its version; missing → `whenMissing`. */
export function commandCheck(input: CommandCheckInput): DoctorCheck {
  const { id, label, command, resolved, outcome } = input;
  if (outcome.timedOut) {
    return check(
      id,
      "skip",
      `${command} --version timed out after ${seconds(DOCTOR_PROBE_TIMEOUT_MS)}`,
      { ...(resolved ? { detail: resolved } : {}) },
    );
  }
  if (outcome.notFound || (!resolved && !outcome.ok)) {
    return check(id, input.whenMissing, `${label} is not on PATH`, {
      detail: `Looked for \`${command}\`.`,
      remediation: input.install,
    });
  }
  if (!outcome.ok) {
    return check(id, "warn", `${command} --version failed`, {
      detail: [resolved, firstLine(outcome.output)].filter(Boolean).join("\n"),
      remediation: `Run \`${command} --version\` in a terminal to see why.`,
    });
  }
  const version = parseCliVersion(outcome.output);
  return check(
    id,
    "ok",
    `${label} ${version ?? "(version not reported)"}`,
    resolved ? { detail: resolved } : {},
  );
}

/**
 * `gh auth status` by EXIT CODE only (its wording changes between gh
 * releases): 0 → ok, non-zero → fail (warn when the GitHub source is off).
 */
export function githubAuthCheck(
  outcome: ProbeOutcome,
  githubEnabled: boolean,
): DoctorCheck {
  const id = "tools.gh-auth";
  if (outcome.notFound) return skippedCheck(id, "gh is not installed");
  if (outcome.timedOut) {
    return skippedCheck(
      id,
      `gh auth status timed out after ${seconds(DOCTOR_PROBE_TIMEOUT_MS)}`,
    );
  }
  if (outcome.ok) return check(id, "ok", "gh is logged in");
  return check(id, githubEnabled ? "fail" : "warn", "gh is not logged in", {
    remediation: "Run `gh auth login` in a terminal.",
    ...(githubEnabled
      ? {}
      : { detail: "The GitHub source is off, so nothing depends on it yet." }),
  });
}

/** `agents.pi-extension`: the installed Harbormaster Pi extension vs the bundled copy. */
export function piExtensionCheck(
  facts: PiExtensionFacts,
  piInstalled: boolean,
): DoctorCheck {
  const id = "agents.pi-extension";
  if (!piInstalled) return skippedCheck(id, "Pi is not installed");
  const restart =
    "Quit and reopen Harbormaster: it installs the bundled extension at start when Pi is on PATH.";
  const installed =
    facts.installedText === undefined
      ? undefined
      : readExtensionVersion(facts.installedText);
  const bundled =
    facts.bundledText === undefined
      ? undefined
      : readExtensionVersion(facts.bundledText);
  switch (comparePiExtension(facts.installedText, facts.bundledText)) {
    case "missing":
      return check(id, "warn", "Harbormaster Pi extension is not installed", {
        detail: `Expected ${facts.installedPath}`,
        remediation: restart,
      });
    case "unversioned":
      return check(id, "warn", "Pi extension has no version marker", {
        detail: facts.installedPath,
        remediation: `Delete ${facts.installedPath}, then: ${restart}`,
      });
    case "stale":
      return check(
        id,
        "warn",
        `Pi extension is stale (v${installed} installed, v${bundled} bundled)`,
        { detail: facts.installedPath, remediation: restart },
      );
    case "differs":
      return check(
        id,
        "warn",
        `Pi extension v${installed} differs from the bundled copy`,
        {
          detail: `${facts.installedPath}\nbundled: ${facts.bundledPath ?? "?"}`,
          remediation: `Delete ${facts.installedPath}, then: ${restart}`,
        },
      );
    case "newer":
      return check(
        id,
        "ok",
        `Pi extension v${installed} (newer than the bundled v${bundled})`,
        { detail: facts.installedPath },
      );
    case "no-bundled":
      return check(id, "ok", `Pi extension v${installed} installed`, {
        detail: `${facts.installedPath}\n(no bundled copy to compare against)`,
      });
    case "current":
      return check(id, "ok", `Pi extension v${installed}, up to date`, {
        detail: facts.installedPath,
      });
  }
}

/** A state file's parse result: a count, or why it was rejected. */
export type StateFileResult =
  | { count: number; missing?: boolean }
  | { error: string };

/** `state.tasks` / `state.bindings`: the file parses and validates. */
export function stateFileCheck(
  id: string,
  file: string,
  noun: string,
  result: StateFileResult,
): DoctorCheck {
  if ("error" in result) {
    return check(id, "fail", `${file} was rejected`, {
      detail: result.error,
      remediation: `Repair ${file} (or move it aside to start empty), then restart Harbormaster.`,
    });
  }
  const plural = result.count === 1 ? noun : `${noun}s`;
  return check(
    id,
    "ok",
    `${result.count} ${plural}${result.missing ? ` (no ${file} yet)` : ""}`,
  );
}

/** Facts for `state.config`. */
export type ConfigCheckInput =
  | { missing: true; path: string }
  | { error: string; path: string }
  | {
      path: string;
      codeRoot?: string | undefined;
      defaultHarness: string;
      customAgents: number;
    };

export function configCheck(input: ConfigCheckInput): DoctorCheck {
  const id = "state.config";
  if ("missing" in input) {
    return check(id, "warn", "No config.json yet (defaults apply)", {
      detail: input.path,
      remediation:
        "Open Harbormaster and finish the Setup screens to write it.",
    });
  }
  if ("error" in input) {
    return check(id, "fail", "config.json was rejected", {
      detail: `${input.path}\n${input.error}`,
      remediation: `Repair ${input.path} (or move it aside to start from defaults), then restart Harbormaster.`,
    });
  }
  const custom =
    input.customAgents > 0
      ? `, ${input.customAgents} custom agent${input.customAgents === 1 ? "" : "s"}`
      : "";
  return check(
    id,
    "ok",
    `default agent ${input.defaultHarness}${custom}`,
    input.codeRoot ? { detail: `codeRoot: ${input.codeRoot}` } : {},
  );
}

/** `state.rules`: every rules file loads; loader problems surface like `harbormaster rules list` shows them. */
export function rulesCheck(
  result: { files: readonly RuleFile[] } | { error: string },
): DoctorCheck {
  const id = "state.rules";
  if ("error" in result) {
    return check(id, "fail", "Could not read the rules", {
      detail: result.error,
      remediation: "Check the rules folder's permissions.",
    });
  }
  const problems = result.files.flatMap((file) =>
    file.problems.map((problem) =>
      problem.startsWith(`${file.file}:`)
        ? problem
        : `${file.file}: ${problem}`,
    ),
  );
  const rules = result.files.reduce((sum, file) => sum + file.rules.length, 0);
  const counts = `${rules} rule${rules === 1 ? "" : "s"} in ${result.files.length} file${result.files.length === 1 ? "" : "s"}`;
  if (problems.length > 0) {
    const broken = result.files.filter((file) => file.problems.length > 0);
    return check(
      id,
      "warn",
      `${broken.length} rules file${broken.length === 1 ? "" : "s"} not loaded (${counts})`,
      {
        detail: capLines(problems, 6),
        remediation:
          "Fix the listed problems (`harbormaster rules list` shows them too); a file with problems contributes no rules.",
      },
    );
  }
  return check(id, "ok", counts);
}

/**
 * `repos.codeRoot`: configured, exists, and spelled the way the disk spells
 * it. A `~/code` vs `~/Code` (case) or symlinked spelling makes worktree
 * and binding paths compare unequal as strings.
 */
export function codeRootCheck(
  configured: string | undefined,
  facts: PathFacts | undefined,
): DoctorCheck {
  const id = "repos.codeRoot";
  const pick =
    "Choose the repositories folder on the Setup screen (Harbormaster menu → Welcome / Setup…).";
  if (!configured || !facts) {
    return check(id, "warn", "No repositories folder configured", {
      remediation: pick,
    });
  }
  if (!facts.exists) {
    return check(id, "fail", `${configured} does not exist`, {
      remediation: `Create it, or ${pick.charAt(0).toLowerCase()}${pick.slice(1)}`,
    });
  }
  if (!facts.isDirectory) {
    return check(id, "fail", `${configured} is not a folder`, {
      remediation: pick,
    });
  }
  const spelled = resolve(configured);
  const real = facts.realPath ?? spelled;
  if (real !== spelled) {
    const caseOnly = real.toLowerCase() === spelled.toLowerCase();
    return check(
      id,
      "warn",
      caseOnly
        ? `${configured} is spelled ${real} on disk (case differs)`
        : `${configured} is a symlink to ${real}`,
      {
        detail:
          "Paths recorded under one spelling do not match paths under the other.",
        remediation: `Set the repositories folder to ${real}: ${pick}`,
      },
    );
  }
  return check(id, "ok", configured);
}

/** `repos.discovered`: how many repositories were found (warn on none). */
export function discoveredCheck(
  count: number,
  codeRoot: string | undefined,
): DoctorCheck {
  const id = "repos.discovered";
  if (count === 0) {
    return check(id, "warn", "No git repositories found", {
      ...(codeRoot ? { detail: `Looked directly under ${codeRoot}.` } : {}),
      remediation:
        "Clone a repository into the repositories folder, or open a folder from the New task composer.",
    });
  }
  return check(id, "ok", `${count} repositor${count === 1 ? "y" : "ies"}`);
}

/** One repository's `ls-remote` outcome. */
export interface RemoteResult {
  id: string;
  root: string;
  probe: RemoteProbe;
}

/** `repos.remote`: every discovered repository's `origin` answers `ls-remote`. */
export function remoteCheck(results: readonly RemoteResult[]): DoctorCheck {
  const id = "repos.remote";
  if (results.length === 0) {
    return skippedCheck(id, "No repositories with an origin remote");
  }
  const failed = results.filter((result) => !result.probe.ok);
  if (failed.length === 0) {
    return check(
      id,
      "ok",
      `${results.length} remote${results.length === 1 ? "" : "s"} reachable`,
    );
  }
  return check(
    id,
    "fail",
    `${failed.length} of ${results.length} remote${results.length === 1 ? "" : "s"} unreachable`,
    {
      detail: capLines(
        failed.map(
          (result) =>
            `${result.id}: ${
              result.probe.timedOut
                ? `timed out after ${seconds(DOCTOR_PROBE_TIMEOUT_MS)}`
                : (result.probe.error ?? "failed")
            }`,
        ),
        10,
      ),
      remediation: `Check the network and your git credentials: \`git -C ${failed[0]?.root} ls-remote origin HEAD\`.`,
    },
  );
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** `disk.free` at the state dir: fail under 1 GiB, warn under 5 GiB. */
export function diskCheck(freeBytes: number, path: string): DoctorCheck {
  const id = "disk.free";
  const summary = `${gib(freeBytes)} free`;
  const remediation =
    "Free up disk space: worktrees and agent sessions need room to grow.";
  if (freeBytes < DISK_FAIL_BYTES) {
    return check(id, "fail", summary, { detail: path, remediation });
  }
  if (freeBytes < DISK_WARN_BYTES) {
    return check(id, "warn", summary, { detail: path, remediation });
  }
  return check(id, "ok", summary, { detail: path });
}

/** `worktrees.orphans`: warn once the orphan scan crosses its threshold. */
export function orphansCheck(report: OrphanWorktreeReport): DoctorCheck {
  const id = "worktrees.orphans";
  const count = report.orphans.length;
  if (report.warning) {
    return check(id, "warn", report.warning, {
      detail: report.orphans
        .slice(0, 10)
        .map((orphan) => orphan.path)
        .join("\n"),
      remediation:
        "Review them (the board's orphan warning has Show in Finder) and delete the ones you do not need.",
    });
  }
  return check(
    id,
    "ok",
    count === 0
      ? "No orphan worktrees"
      : `${count} orphan worktree${count === 1 ? "" : "s"} (under the threshold)`,
  );
}

/** `socket.tool`: the local tool socket answers (the CLI and agent tools reach the app through it). */
export function socketCheck(facts: ToolSocketFacts): DoctorCheck {
  const id = "socket.tool";
  if (facts.responds) {
    return check(id, "ok", "The app answers on the tool socket", {
      detail: facts.path,
    });
  }
  return check(
    id,
    "warn",
    facts.exists
      ? "Nothing answers on the tool socket (stale socket file)"
      : "Harbormaster app is not running",
    {
      detail: [facts.path, facts.error].filter(Boolean).join("\n"),
      remediation:
        "Start Harbormaster: the CLI and agents' Harbormaster tools need the running app.",
    },
  );
}

/** Login-shell PATH entries the process PATH lacks (order kept, deduplicated). */
export function missingPathEntries(
  loginShellPath: string,
  processPath: string,
): string[] {
  const have = new Set(processPath.split(delimiter).filter(Boolean));
  const missing: string[] = [];
  for (const entry of loginShellPath.split(delimiter)) {
    if (!entry || have.has(entry) || missing.includes(entry)) continue;
    missing.push(entry);
  }
  return missing;
}

/** `path.loginShell`: every login-shell PATH directory is on the PATH core resolves commands with. */
export function loginShellPathCheck(
  loginShellPath: string | undefined,
  processPath: string,
): DoctorCheck {
  const id = "path.loginShell";
  if (!loginShellPath) {
    return skippedCheck(id, "No login-shell PATH to compare");
  }
  const missing = missingPathEntries(loginShellPath, processPath);
  if (missing.length === 0) {
    return check(
      id,
      "ok",
      "Every login-shell PATH directory is on the app's PATH",
    );
  }
  return check(
    id,
    "warn",
    `${missing.length} login-shell PATH director${missing.length === 1 ? "y is" : "ies are"} missing from the app's PATH`,
    {
      detail: missing.join("\n"),
      remediation:
        "Quit and reopen Harbormaster (it reads your login shell's PATH at start); commands installed there are not found until then.",
    },
  );
}

/** Checks sorted into display order: by group (`DOCTOR_GROUPS`), stable within a group. */
export function orderDoctorChecks(
  checks: readonly DoctorCheck[],
): DoctorCheck[] {
  const rank = (group: string): number => {
    const index = DOCTOR_GROUPS.indexOf(group);
    return index === -1 ? DOCTOR_GROUPS.length : index;
  };
  return checks
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) => rank(a.item.group) - rank(b.item.group) || a.index - b.index,
    )
    .map(({ item }) => item);
}

/** Counts per status. */
export function doctorCounts(
  report: Pick<DoctorReport, "checks">,
): Record<DoctorStatus, number> {
  const counts: Record<DoctorStatus, number> = {
    ok: 0,
    warn: 0,
    fail: 0,
    skip: 0,
  };
  for (const item of report.checks) counts[item.status]++;
  return counts;
}

/** The CLI's exit code: 1 when any check failed. */
export function doctorExitCode(report: Pick<DoctorReport, "checks">): number {
  return report.checks.some((item) => item.status === "fail") ? 1 : 0;
}

function indent(text: string, prefix: string): string[] {
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

/**
 * Human-readable report: one block per group, `✓ / ! / ✗ / -` per check,
 * details and remediation indented under it, and a totals line.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  let group: string | undefined;
  for (const item of orderDoctorChecks(report.checks)) {
    if (item.group !== group) {
      if (group !== undefined) lines.push("");
      group = item.group;
      lines.push(doctorGroupTitle(group));
    }
    lines.push(
      `  ${DOCTOR_STATUS_SYMBOLS[item.status]} ${item.id}  ${item.summary}`,
    );
    if (item.detail && item.status !== "ok") {
      lines.push(...indent(item.detail, "      "));
    }
    if (
      item.remediation &&
      (item.status === "warn" || item.status === "fail")
    ) {
      lines.push(...indent(`→ ${item.remediation}`, "      "));
    }
  }
  const counts = doctorCounts(report);
  lines.push(
    "",
    `${counts.ok} ok, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.fail} failed, ${counts.skip} skipped`,
  );
  return lines.join("\n");
}

/** The version a passing `--version` check reported (`agents.pi` → `0.9.1`), if any. */
function reportedVersion(
  report: Pick<DoctorReport, "checks">,
  id: string,
): string {
  const item = report.checks.find((entry) => entry.id === id);
  if (!item) return "not checked";
  if (item.status !== "ok") return item.summary;
  return parseCliVersion(item.summary) ?? item.summary;
}

/**
 * A short plain-text block for pasting into Slack with a bug report: app
 * and OS versions, the agent versions, and every failing / warning check.
 */
export function doctorPlainSummary(
  report: DoctorReport,
  facts: { appVersion?: string; os?: string } = {},
): string {
  const appVersion = facts.appVersion ?? report.appVersion ?? "unknown";
  const lines = [
    `Harbormaster ${appVersion}${facts.os ? ` on ${facts.os}` : ""}`,
    `pi: ${reportedVersion(report, "agents.pi")}`,
    `claude: ${reportedVersion(report, "agents.claude")}`,
  ];
  const problems = orderDoctorChecks(report.checks).filter(
    (item) => item.status === "fail" || item.status === "warn",
  );
  if (problems.length === 0) {
    lines.push("doctor: all checks passed");
  } else {
    lines.push("doctor:");
    for (const item of problems) {
      lines.push(
        `  ${DOCTOR_STATUS_SYMBOLS[item.status]} ${item.id}: ${item.summary}`,
      );
    }
  }
  return lines.join("\n");
}
