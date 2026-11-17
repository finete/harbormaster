// Engine: the pure decisions behind `harbormaster doctor` (CLI, the app's
// Setup screen "Check setup", the diagnostics bundle's doctor.json): how a
// probe's raw facts map to ok / warn / fail / skip, the thresholds, the
// display order, and the plain-text renderings. No I/O here; the probes are
// `EnvironmentProbeAccess`, the sequencing is `manager/doctor-runtime.ts`.

import { delimiter, resolve } from "node:path";
import type { OrphanWorktreeReport } from "../contracts/commands.js";
import {
  type DoctorCheck,
  type DoctorCheckItem,
  type DoctorReport,
  type DoctorStatus,
  LOCAL_PROBE_TIMEOUT_MS,
  NETWORK_PROBE_TIMEOUT_MS,
  type PathFacts,
  type PiExtensionFacts,
  REMOTE_PROBE_CAP,
  type RemoteProbe,
  type ToolSocketFacts,
} from "../contracts/doctor.js";
import type { HarnessDescriptor } from "../contracts/harness.js";
import type { GlobalConfig } from "../contracts/model.js";
import type { ProbeOutcome } from "../contracts/onboarding.js";
import type { RuleFile } from "../contracts/rules.js";
import {
  comparePiExtension,
  readExtensionVersion,
} from "../utilities/pi-extension.js";
import {
  isUntrustedCertificateError,
  TLS_TRUST_HINT,
} from "../utilities/tls-trust.js";
import {
  type AgentProbe,
  agentUpgradeHint,
  agentVersionFloor,
} from "./agent-version.js";
import { isConnectivityError, isTransientError } from "./connectivity.js";
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
  extra: {
    detail?: string | undefined;
    remediation?: string | undefined;
    items?: DoctorCheckItem[] | undefined;
  } = {},
): DoctorCheck {
  return {
    group: id.split(".")[0] as string,
    id,
    status,
    summary,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.remediation ? { remediation: extra.remediation } : {}),
    ...(extra.items && extra.items.length > 0 ? { items: extra.items } : {}),
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
      `${command} --version timed out after ${seconds(LOCAL_PROBE_TIMEOUT_MS)}`,
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

/** Facts for an agent CLI check (`agents.<harness id>`). */
export interface AgentCheckInput {
  descriptor: Pick<
    HarnessDescriptor,
    | "id"
    | "label"
    | "installHint"
    | "upgradeHint"
    | "minVersion"
    | "verifiedVersion"
    | "versionArgs"
  >;
  probe: AgentProbe;
  /** The default agent's problems fail; other agents' warn. */
  isDefault: boolean;
}

/**
 * One built-in agent (docs/harness-additions.md P7): found (skipping
 * terminal shims), its version command answers, and the version against
 * the descriptor's floors. Below `minVersion` → fail for the default agent,
 * warn otherwise, with its upgrade command; above `verifiedVersion` → ok,
 * "newer than tested".
 */
export function agentCheck(input: AgentCheckInput): DoctorCheck {
  const { descriptor, probe } = input;
  const id = `agents.${descriptor.id}`;
  const label = descriptor.label;
  const severity = input.isDefault ? "fail" : "warn";
  const agentCommand = probe.command.split(" ")[0] ?? probe.command;
  const versionCommand = [probe.command, ...descriptor.versionArgs].join(" ");
  const done = (item: DoctorCheck): DoctorCheck => ({ ...item, agentCommand });
  const install = `Install ${label} (\`${descriptor.installHint}\`), then reopen Harbormaster.`;
  if (probe.shim && !probe.path) {
    return done(
      check(id, severity, `${label}: only a terminal shim was found`, {
        detail: `${probe.shim} is a terminal multiplexer's wrapper, not ${label}.`,
        remediation: `${install} If it is installed, add its folder to your login shell's PATH.`,
      }),
    );
  }
  const outcome = probe.outcome;
  if (!probe.path || !outcome || outcome.notFound) {
    return done(
      check(id, severity, `${label} is not on PATH`, {
        detail: `Looked for \`${probe.command}\`.`,
        remediation: install,
      }),
    );
  }
  if (outcome.timedOut) {
    return done(
      check(
        id,
        "skip",
        `${versionCommand} timed out after ${seconds(LOCAL_PROBE_TIMEOUT_MS)}`,
        { detail: probe.path },
      ),
    );
  }
  if (!outcome.ok) {
    return done(
      check(id, "warn", `${versionCommand} failed`, {
        detail: [probe.path, firstLine(outcome.output)]
          .filter(Boolean)
          .join("\n"),
        remediation: `Run \`${versionCommand}\` in a terminal to see why.`,
      }),
    );
  }
  const version = probe.version;
  const floor = agentVersionFloor(version, descriptor);
  if (floor === "below-min") {
    return done(
      check(
        id,
        severity,
        `${label} ${version} is older than the minimum ${descriptor.minVersion}`,
        {
          detail: probe.path,
          remediation: `Upgrade ${label}: \`${agentUpgradeHint(descriptor)}\`.`,
        },
      ),
    );
  }
  const summary =
    floor === "newer-than-verified"
      ? `${label} ${version}, newer than tested (${descriptor.verifiedVersion})`
      : `${label} ${version ?? "(version not reported)"}`;
  return done(check(id, "ok", summary, { detail: probe.path }));
}

/** gh's wording for "could not reach the API" (as opposed to "not logged in"). */
const NETWORK_ERROR =
  /timeout|timed out|no such host|could not resolve|dial tcp|network is unreachable|connection refused|connection reset|i\/o timeout|error connecting to|TLS handshake/i;

/** Whether `gh auth status` reached api.github.com: it validates the token there. */
export type GithubReachability = "reachable" | "unreachable" | "unknown";

/**
 * Exit 0 → reachable; a timeout or a network-error wording → unreachable;
 * anything else (not installed, not logged in) proves nothing either way.
 */
export function githubReachability(outcome: ProbeOutcome): GithubReachability {
  if (outcome.ok) return "reachable";
  if (outcome.timedOut) return "unreachable";
  if (!outcome.notFound && NETWORK_ERROR.test(outcome.output)) {
    return "unreachable";
  }
  return "unknown";
}

/**
 * `gh auth status`, which also proves api.github.com answers (gh validates
 * the token there). Logged in / not by EXIT CODE only (its wording changes
 * between gh releases): 0 → ok, non-zero → fail (warn when the GitHub
 * source is off). A timeout or a network error → warn: GitHub is
 * unreachable, so `repos.remote` skips github.com remotes.
 */
export function githubAuthCheck(
  outcome: ProbeOutcome,
  githubEnabled: boolean,
  ms?: number,
): DoctorCheck {
  const id = "tools.gh-auth";
  if (outcome.notFound) return skippedCheck(id, "gh is not installed");
  const network =
    "Check the network (VPN, proxy, DNS); github.com remotes are not probed until api.github.com answers.";
  if (outcome.timedOut) {
    return check(
      id,
      "warn",
      `gh auth status did not answer within ${seconds(NETWORK_PROBE_TIMEOUT_MS)} (api.github.com unreachable)`,
      { remediation: network },
    );
  }
  if (outcome.ok) {
    return check(
      id,
      "ok",
      ms === undefined
        ? "gh is logged in (api.github.com reachable)"
        : `gh is logged in (api.github.com reachable, ${Math.round(ms)} ms)`,
    );
  }
  if (githubReachability(outcome) === "unreachable") {
    return check(id, "warn", "gh could not reach api.github.com", {
      detail: firstLine(outcome.output),
      remediation: network,
    });
  }
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

/** A task as the `repos.remote` scope rule sees it. */
export interface RemoteScopeTask {
  state: string;
  repositoryId?: string | undefined;
  updatedAt: string;
}

/** Why a repository's remote was not probed. */
export const NOT_PROBED_NO_ACTIVE_TASK = "not probed (no active task)";

/** Which repositories `repos.remote` probes, and why the rest are not. */
export interface RemoteScope<R extends { id: string }> {
  probe: R[];
  notProbed: Array<{ id: string; reason: string }>;
  /** Set when nothing is probed: why. */
  skipReason?: string;
}

function newestFirst<T extends { updatedAt: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * `repos.remote`'s scope (an `ls-remote` costs seconds on a remote with
 * many refs, so the doctor does not probe every checkout): the
 * repositories with a task in `working` / `awaiting`, newest task first,
 * at most `REMOTE_PROBE_CAP`; with none active, the repository of the most
 * recently updated task; else nothing (`skipReason`). `all` probes every
 * repository (`harbormaster doctor --all-remotes`).
 */
export function selectRemoteProbes<R extends { id: string }>(
  repositories: readonly R[],
  tasks: readonly RemoteScopeTask[],
  options: { all?: boolean | undefined; cap?: number } = {},
): RemoteScope<R> {
  if (options.all) return { probe: [...repositories], notProbed: [] };
  const cap = options.cap ?? REMOTE_PROBE_CAP;
  const byId = new Map(repositories.map((repo) => [repo.id, repo]));
  const known = newestFirst(
    tasks.filter((task) => task.repositoryId && byId.has(task.repositoryId)),
  );
  const active: string[] = [];
  for (const task of known) {
    if (task.state !== "working" && task.state !== "awaiting") continue;
    const id = task.repositoryId as string;
    if (!active.includes(id)) active.push(id);
  }
  let chosen = active.slice(0, cap);
  const overflow = new Set(active.slice(cap));
  if (chosen.length === 0 && known[0]) {
    chosen = [known[0].repositoryId as string];
  }
  const notProbed = repositories
    .filter((repo) => !chosen.includes(repo.id))
    .map((repo) => ({
      id: repo.id,
      reason: overflow.has(repo.id)
        ? `not probed (more than ${cap} repositories with active tasks)`
        : NOT_PROBED_NO_ACTIVE_TASK,
    }));
  const probe = chosen.map((id) => byId.get(id) as R);
  if (probe.length > 0) return { probe, notProbed };
  return {
    probe,
    notProbed,
    skipReason: "Not probed: no repository has a task (active or recent)",
  };
}

/** git's wording for a definite failure (the remote said no, or the host does not resolve). */
const DEFINITE_REMOTE_ERROR = [
  /repository not found/i,
  /repository '.*' not found/i,
  /permission denied/i,
  /could not read from remote/i,
  /authentication failed/i,
  /could not resolve host/i,
  /could not resolve hostname/i,
  /nodename nor servname/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  // git refuses the remote's protocol (GIT_ALLOW_PROTOCOL / protocol.allow).
  /transport '.*' not allowed/i,
];

/** The text for a remote that did not answer in time. */
export const REMOTE_TIMEOUT_REMEDIATION = `the remote did not answer within ${seconds(NETWORK_PROBE_TIMEOUT_MS)}; a remote that advertises very many refs (~100k refs, ~10+ MB of listing) makes every ls-remote/fetch slow; this is a property of the remote, not of Harbormaster`;

/**
 * One `ls-remote`'s verdict: `ok` when it answered (exit 0, or 2: reachable
 * but no HEAD advertised); `fail` only for a definite error (exit 128 with
 * "Repository not found", "Permission denied", "Could not read from
 * remote", "Authentication failed", a DNS failure); `warn` for a timeout
 * or anything unclassified.
 */
export function classifyRemoteProbe(probe: RemoteProbe): {
  status: DoctorStatus;
  summary: string;
} {
  if (probe.ok) return { status: "ok", summary: "reachable" };
  if (probe.timedOut) {
    return {
      status: "warn",
      summary: `did not answer within ${seconds(NETWORK_PROBE_TIMEOUT_MS)}`,
    };
  }
  if (probe.exitCode === 2) {
    return { status: "ok", summary: "reachable (no HEAD advertised)" };
  }
  const error = probe.error ?? "";
  if (
    (probe.exitCode === undefined || probe.exitCode === 128) &&
    DEFINITE_REMOTE_ERROR.some((pattern) => pattern.test(error))
  ) {
    return { status: "fail", summary: error };
  }
  return {
    status: "warn",
    summary: `failed: ${error || `exit ${probe.exitCode ?? "?"}`}`,
  };
}

/** One repository under `repos.remote`: probed, or skipped before probing (`skipped`: why, e.g. `api.github.com unreachable`). */
export interface RemoteResult {
  id: string;
  root: string;
  probe?: RemoteProbe;
  skipped?: string;
}

const STATUS_RANK: Record<DoctorStatus, number> = {
  skip: 0,
  ok: 1,
  warn: 2,
  fail: 3,
};

/** The worst status of `statuses` (`skip` when empty). */
export function worstStatus(statuses: readonly DoctorStatus[]): DoctorStatus {
  return statuses.reduce<DoctorStatus>(
    (worst, status) =>
      STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst,
    "skip",
  );
}

/**
 * `repos.remote`: each probed repository's `origin` answers `ls-remote`,
 * one item per repository; the check's status is the worst item's. The
 * repositories outside the scope (`selectRemoteProbes`) are listed in
 * `detail`.
 */
export function remoteCheck(
  results: readonly RemoteResult[],
  scope: {
    notProbed?: ReadonlyArray<{ id: string; reason: string }>;
    skipReason?: string | undefined;
  } = {},
): DoctorCheck {
  const id = "repos.remote";
  const notProbed = scope.notProbed ?? [];
  const notProbedDetail =
    notProbed.length > 0
      ? [
          capLines(
            notProbed.map((entry) => `${entry.id}: ${entry.reason}`),
            10,
          ),
          "`harbormaster doctor --all-remotes` probes every repository.",
        ].join("\n")
      : undefined;
  if (results.length === 0) {
    if (notProbed.length === 0) {
      return skippedCheck(id, "No repositories with an origin remote");
    }
    return check(id, "skip", scope.skipReason ?? "No remote probed", {
      detail: notProbedDetail,
    });
  }
  const items: DoctorCheckItem[] = results.map((result) => {
    if (!result.probe) {
      return {
        name: result.id,
        status: "skip",
        summary: `not probed (${result.skipped ?? "skipped"})`,
      };
    }
    const verdict = classifyRemoteProbe(result.probe);
    return {
      name: result.id,
      ...verdict,
      ...(result.probe.ms !== undefined ? { ms: result.probe.ms } : {}),
    };
  });
  const status = worstStatus(items.map((item) => item.status));
  const probed = items.filter((item) => item.status !== "skip");
  const count = (n: number, noun: string): string =>
    `${n} ${noun}${n === 1 ? "" : "s"}`;
  const notProbedCount = notProbed.length + (items.length - probed.length);
  const suffix = notProbedCount > 0 ? `; ${notProbedCount} not probed` : "";
  if (probed.length === 0) {
    const reasons = [
      ...new Set(results.map((result) => result.skipped ?? "skipped")),
    ];
    return check(id, "skip", `Not probed: ${reasons.join("; ")}`, {
      detail: notProbedDetail,
      items,
    });
  }
  const failed = items.filter((item) => item.status === "fail");
  const timedOut = results.filter((result) => result.probe?.timedOut);
  const unclear = items.filter((item) => item.status === "warn").length;
  const summary =
    status === "ok"
      ? `${count(probed.length, "remote")} reachable${suffix}`
      : `${[
          failed.length > 0 ? `${failed.length} unreachable` : "",
          timedOut.length > 0
            ? `${timedOut.length} did not answer within ${seconds(NETWORK_PROBE_TIMEOUT_MS)}`
            : "",
          unclear > timedOut.length
            ? `${unclear - timedOut.length} failed (unclear why)`
            : "",
        ]
          .filter(Boolean)
          .join(", ")} (of ${probed.length} probed)${suffix}`;
  const firstProblem = results.find((result) => {
    const item = items.find((entry) => entry.name === result.id);
    return item?.status === "fail" || item?.status === "warn";
  });
  const remediation = [
    failed.length > 0 || unclear > timedOut.length
      ? `Check the network and your git credentials: \`git -C ${firstProblem?.root} ls-remote origin HEAD\`.`
      : "",
    timedOut.length > 0
      ? `${REMOTE_TIMEOUT_REMEDIATION.charAt(0).toUpperCase()}${REMOTE_TIMEOUT_REMEDIATION.slice(1)}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return check(id, status, summary, {
    detail: notProbedDetail,
    remediation: remediation || undefined,
    items,
  });
}

/** One deployment stage's version URL to probe; stages sharing a URL are probed once. */
export interface VersionEndpointTarget {
  url: string;
  /** Every `repo stage` reading this URL, for the item name. */
  stages: string[];
}

/**
 * The https `options.url` of every `version-endpoint`-hooked deployment
 * stage in `config`, one target per distinct URL, in config order.
 */
export function versionEndpointTargets(
  config: GlobalConfig,
): VersionEndpointTarget[] {
  const byUrl = new Map<string, VersionEndpointTarget>();
  for (const [repoId, repo] of Object.entries(config.repositories ?? {})) {
    for (const stage of repo.deployment?.stages ?? []) {
      const url = stage.options?.url;
      if (stage.hook !== "version-endpoint") continue;
      if (typeof url !== "string" || !/^https:\/\//i.test(url)) continue;
      const name = `${repoId} ${stage.id}`;
      const known = byUrl.get(url);
      if (known) known.stages.push(name);
      else byUrl.set(url, { url, stages: [name] });
    }
  }
  return [...byUrl.values()];
}

/** `url` without credentials or query (`https://user:pw@host/v?k` → `https://host/v`), for display. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

/** One probed version endpoint: the fetch's error message, or none when it answered. */
export interface VersionEndpointResult {
  target: VersionEndpointTarget;
  error?: string;
  ms?: number;
}

/**
 * `repos.version-endpoints`: each deployment stage's version URL answers a
 * GET through the same HTTP access the version-endpoint source uses (in the
 * app: Chromium's network stack and the OS trust store). An untrusted
 * certificate (a TLS-inspecting proxy) fails with the trust remediation;
 * offline / timeout warns; any other error (HTTP 404, ...) fails. The
 * worst item is the check's status. Credentials never reach the output.
 */
export function versionEndpointCheck(
  results: readonly VersionEndpointResult[],
): DoctorCheck {
  const id = "repos.version-endpoints";
  if (results.length === 0) {
    return skippedCheck(id, "No version-endpoint deployment stages configured");
  }
  let tls = 0;
  const items: DoctorCheckItem[] = results.map((result) => {
    const name = `${result.target.stages.join(", ")} (${displayUrl(result.target.url)})`;
    const timing = result.ms !== undefined ? { ms: result.ms } : {};
    if (result.error === undefined) {
      return { name, status: "ok", summary: "reachable", ...timing };
    }
    // The access's message embeds the full URL: keep it out of the output.
    const reason = result.error
      .split(result.target.url)
      .join(displayUrl(result.target.url));
    if (isUntrustedCertificateError(reason)) {
      tls++;
      return {
        name,
        status: "fail",
        summary: "TLS certificate not trusted",
        ...timing,
      };
    }
    const offline = isConnectivityError(reason) || isTransientError(reason);
    return {
      name,
      status: offline ? "warn" : "fail",
      summary: firstLine(reason) ?? reason,
      ...timing,
    };
  });
  const status = worstStatus(items.map((item) => item.status));
  const reachable = items.filter((item) => item.status === "ok").length;
  const summary =
    status === "ok"
      ? `${reachable} version endpoint${reachable === 1 ? "" : "s"} reachable`
      : `${items.length - reachable} of ${items.length} version endpoints failed${tls > 0 ? ` (${tls} with an untrusted TLS certificate)` : ""}`;
  const remediation =
    tls > 0
      ? `${TLS_TRUST_HINT.charAt(0).toUpperCase()}${TLS_TRUST_HINT.slice(1)}. Check with \`curl -sI <url>\` (curl uses the keychain).`
      : status === "ok"
        ? undefined
        : "Check the stage's options.url in config.json and the network (VPN, proxy).";
  return check(id, status, summary, { remediation, items });
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
    for (const entry of item.items ?? []) {
      lines.push(
        `      ${DOCTOR_STATUS_SYMBOLS[entry.status]} ${entry.name}  ${entry.summary}${
          entry.ms !== undefined ? ` (${Math.round(entry.ms)} ms)` : ""
        }`,
      );
    }
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

/** The version a passing agent check reported (`agents.pi` → `0.9.1`), else its summary. */
function reportedVersion(item: DoctorCheck): string {
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
    ...report.checks
      .filter((item) => item.agentCommand)
      .map((item) => `${item.agentCommand}: ${reportedVersion(item)}`),
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
