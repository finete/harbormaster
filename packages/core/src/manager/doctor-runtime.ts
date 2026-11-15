// Manager helper: the `doctor` use case (`CoreCommands.doctor`), kept out
// of core-manager.ts like the rules runtime. Sequences the read-only probes
// (`EnvironmentProbeAccess`, the state accessors' read verbs) and hands the
// raw facts to `engines/doctor.ts` for the verdicts. Never writes: a missing
// config is reported, not created, and rules are parsed without the
// managed-file / default-rules writes `listRules` does, so the CLI can run
// this against a state dir while the app is down. Every check is bounded by
// a timeout and never throws (a probe that fails reports `skip`), and
// carries its wall-clock time (`ms`). Local probes get
// `LOCAL_PROBE_TIMEOUT_MS`, network probes `NETWORK_PROBE_TIMEOUT_MS`, at
// most `NETWORK_PROBE_CONCURRENCY` `ls-remote`s at once, and only for the
// repositories `selectRemoteProbes` picks (or every one with
// `probeAllRemotes`), after `gh auth status` showed api.github.com answers.

import type { OrphanWorktreeReport } from "../contracts/commands.js";
import {
  type DoctorCheck,
  type DoctorInput,
  type DoctorReport,
  type EnvironmentProbeAccess,
  LOCAL_PROBE_TIMEOUT_MS,
  NETWORK_PROBE_CONCURRENCY,
  NETWORK_PROBE_TIMEOUT_MS,
  type RemoteProbe,
} from "../contracts/doctor.js";
import { DEFAULT_HARNESS_ID, type GlobalConfig } from "../contracts/model.js";
import type { RuleFile, RulesFileAccess } from "../contracts/rules.js";
import type {
  ConfigAccess,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../contracts/services.js";
import type { RepositoryInfo } from "../contracts/workspace.js";
import {
  codeRootCheck,
  commandCheck,
  configCheck,
  DOCTOR_SCAN_TIMEOUT_MS,
  discoveredCheck,
  diskCheck,
  type GithubReachability,
  githubAuthCheck,
  githubReachability,
  loginShellPathCheck,
  orderDoctorChecks,
  orphansCheck,
  piExtensionCheck,
  type RemoteResult,
  remoteCheck,
  rulesCheck,
  selectRemoteProbes,
  skippedCheck,
  socketCheck,
  stateFileCheck,
} from "../engines/doctor.js";
import { parseRuleFile } from "../engines/rules/rule-files.js";
import { forEachConcurrently } from "../utilities/concurrency.js";

/** Slack on top of a probe's own timeout before the doctor gives up on it. */
const GUARD_SLACK_MS = 1_000;
/** Backstop for one local check (the probe's own timeout plus slack). */
const LOCAL_GUARD_MS = LOCAL_PROBE_TIMEOUT_MS + GUARD_SLACK_MS;
/** Backstop for one network check. */
const NETWORK_GUARD_MS = NETWORK_PROBE_TIMEOUT_MS + GUARD_SLACK_MS;

/** A repository id on github.com (its `ls-remote` needs api.github.com's host up). */
function onGithub(repositoryId: string): boolean {
  return repositoryId.startsWith("github.com/");
}

export interface DoctorRuntimeDependencies {
  probes: EnvironmentProbeAccess;
  config: ConfigAccess;
  tasks: TaskStateAccess;
  bindings: WorkspaceBindingAccess;
  /** The rules dir (read verbs only). */
  rules?: RulesFileAccess;
  now: () => Date;
  /** Every known repository for a config (the manager's discovery). */
  repositories: (config: GlobalConfig) => Promise<RepositoryInfo[]>;
  /** The orphan-worktree scan (read-only). */
  orphans: () => Promise<OrphanWorktreeReport>;
}

class DoctorTimeout extends Error {}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `work` within `ms`: its value, or the throw / timeout as data (never rejects). */
async function settle<T>(
  ms: number,
  work: () => Promise<T>,
): Promise<{ value: T; ms: number } | { error: string; ms: number }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DoctorTimeout()), ms);
      }),
    ]);
    return { value, ms: Date.now() - started };
  } catch (error) {
    return {
      error:
        error instanceof DoctorTimeout
          ? `Timed out after ${Math.round(ms / 1000)} s`
          : `Could not check: ${describe(error)}`,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** `work` within `ms`, timed (`ms`); a throw or a timeout becomes a `skip` check for `id`. */
async function guarded(
  id: string,
  ms: number,
  work: () => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
  const result = await settle(ms, work);
  return "value" in result
    ? { ...result.value, ms: result.ms }
    : { ...skippedCheck(id, result.error), ms: result.ms };
}

/** A check computed without probing (no wait). */
function instant(item: DoctorCheck): Promise<DoctorCheck> {
  return Promise.resolve({ ...item, ms: 0 });
}

/** The loaded config, or why it is not available (missing / rejected). */
type ConfigState =
  | { config: GlobalConfig; path: string }
  | { missing: true; path: string }
  | { error: string; path: string };

export class DoctorRuntime {
  constructor(private readonly deps: DoctorRuntimeDependencies) {}

  async run(input: DoctorInput = {}): Promise<DoctorReport> {
    const checkedAt = this.deps.now().toISOString();
    const { probes } = this.deps;
    const configState = await this.loadConfig();
    const config = "config" in configState ? configState.config : undefined;
    const defaultHarness = config?.launch?.defaultHarness ?? DEFAULT_HARNESS_ID;
    const githubEnabled = config?.sources?.github?.enabled !== false;
    const commands = probes.commands();
    const probe = LOCAL_GUARD_MS;
    // One `gh auth status`: `tools.gh-auth`'s verdict and the proof that
    // api.github.com answers, which `repos.remote` waits for.
    const ghAuth = settle(NETWORK_GUARD_MS, () => probes.githubAuthStatus());

    const command = (
      id: string,
      label: string,
      name: string,
      whenMissing: "fail" | "warn",
      install: string,
    ): Promise<DoctorCheck> =>
      guarded(id, probe, async () => {
        const [resolved, outcome] = await Promise.all([
          probes.resolveCommand(name),
          probes.commandVersion(name),
        ]);
        return commandCheck({
          id,
          label,
          command: name,
          resolved,
          outcome,
          whenMissing,
          install,
        });
      });

    const pi = command(
      "agents.pi",
      "Pi",
      commands.pi,
      defaultHarness === "pi" ? "fail" : "warn",
      "Install Pi (`npm install -g @earendil-works/pi-coding-agent`), then reopen Harbormaster.",
    );
    const checks = await Promise.all([
      command(
        "tools.git",
        "git",
        commands.git,
        "fail",
        "Install git (`xcode-select --install` or `brew install git`).",
      ),
      command(
        "tools.gh",
        "gh",
        commands.gh,
        githubEnabled ? "fail" : "warn",
        "Install the GitHub CLI (`brew install gh`), then run `gh auth login`.",
      ),
      ghAuth.then((result) =>
        "value" in result
          ? {
              ...githubAuthCheck(result.value, githubEnabled, result.ms),
              ms: result.ms,
            }
          : { ...skippedCheck("tools.gh-auth", result.error), ms: result.ms },
      ),
      pi,
      command(
        "agents.claude",
        "Claude Code",
        commands.claude,
        defaultHarness === "claude-code" ? "fail" : "warn",
        "Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`), then reopen Harbormaster.",
      ),
      guarded("agents.pi-extension", probe, async () =>
        piExtensionCheck(
          await probes.piExtension(),
          (await pi).status === "ok",
        ),
      ),
      instant(configCheck(configCheckInput(configState))),
      guarded("state.tasks", probe, async () =>
        stateFileCheck(
          "state.tasks",
          "tasks.json",
          "task",
          await this.deps.tasks.listTasks().then(
            (tasks) => ({ count: tasks.length }),
            (error: unknown) => ({ error: describe(error) }),
          ),
        ),
      ),
      guarded("state.bindings", probe, async () =>
        stateFileCheck(
          "state.bindings",
          "workspace-bindings.json",
          "workspace binding",
          await this.deps.bindings.listBindings().then(
            (bindings) => ({ count: bindings.length }),
            (error: unknown) => ({ error: describe(error) }),
          ),
        ),
      ),
      guarded("state.rules", probe, () => this.rulesCheck()),
      ...this.repositoryChecks(config, {
        all: input.probeAllRemotes === true,
        github: ghAuth.then((result) =>
          "value" in result ? githubReachability(result.value) : "unknown",
        ),
      }),
      config
        ? guarded("worktrees.orphans", DOCTOR_SCAN_TIMEOUT_MS, async () =>
            orphansCheck(await this.deps.orphans()),
          )
        : instant(skippedCheck("worktrees.orphans", "No usable config.json")),
      guarded("disk.free", probe, async () => {
        const disk = await probes.stateDirFreeBytes();
        return diskCheck(disk.freeBytes, disk.path);
      }),
      guarded("socket.tool", probe, async () =>
        socketCheck(await probes.toolSocket()),
      ),
      instant(loginShellPathCheck(input.loginShellPath, probes.processPath())),
    ]);
    return {
      checkedAt,
      checks: orderDoctorChecks(checks),
      ...(input.appVersion ? { appVersion: input.appVersion } : {}),
      platform: probes.platform(),
    };
  }

  private async loadConfig(): Promise<ConfigState> {
    const file = await this.deps.probes.configFile().catch(() => undefined);
    const path = file?.path ?? "config.json";
    // Loading a missing config writes the defaults: the doctor never writes.
    if (!file?.exists) return { missing: true, path };
    try {
      return { config: await this.deps.config.load(), path };
    } catch (error) {
      return { error: describe(error), path };
    }
  }

  private async rulesCheck(): Promise<DoctorCheck> {
    const rules = this.deps.rules;
    if (!rules) return skippedCheck("state.rules", "Rules are not configured");
    let files: RuleFile[];
    try {
      files = (await rules.readRuleFiles()).map((text) => parseRuleFile(text));
    } catch (error) {
      return rulesCheck({ error: describe(error) });
    }
    return rulesCheck({ files });
  }

  /** `repos.codeRoot`, `repos.discovered`, `repos.remote` (discovery shared by the last two). */
  private repositoryChecks(
    config: GlobalConfig | undefined,
    remotes: {
      /** Probe every repository (`probeAllRemotes`). */
      all: boolean;
      /** Whether api.github.com answered `gh auth status` (never rejects). */
      github: Promise<GithubReachability>;
    },
  ): Array<Promise<DoctorCheck>> {
    if (!config) {
      return ["repos.codeRoot", "repos.discovered", "repos.remote"].map((id) =>
        instant(skippedCheck(id, "No usable config.json")),
      );
    }
    const { probes } = this.deps;
    const codeRoot = config.codeRoot;
    const discovery = this.deps.repositories(config);
    // Settled here so a rejected discovery is never an unhandled rejection
    // while one of the checks is still waiting on another probe.
    discovery.catch(() => {});
    // Discovery, then `gh auth status`, then the `ls-remote` rounds.
    const remoteBudget = (count: number): number =>
      DOCTOR_SCAN_TIMEOUT_MS +
      NETWORK_GUARD_MS +
      Math.ceil(count / NETWORK_PROBE_CONCURRENCY) * NETWORK_PROBE_TIMEOUT_MS +
      GUARD_SLACK_MS;
    return [
      guarded("repos.codeRoot", LOCAL_GUARD_MS, async () =>
        codeRootCheck(
          codeRoot,
          codeRoot ? await probes.pathFacts(codeRoot) : undefined,
        ),
      ),
      guarded("repos.discovered", DOCTOR_SCAN_TIMEOUT_MS, async () =>
        discoveredCheck((await discovery).length, codeRoot),
      ),
      discovery
        .then(
          (repositories) =>
            repositories.filter((repo) => repo.remoteUrl).length,
          () => 0,
        )
        .then((count) =>
          guarded("repos.remote", remoteBudget(count), () =>
            this.remoteCheck(discovery, remotes),
          ),
        ),
    ];
  }

  /** `repos.remote`: the scoped `ls-remote`s, `NETWORK_PROBE_CONCURRENCY` at a time. */
  private async remoteCheck(
    discovery: Promise<RepositoryInfo[]>,
    remotes: { all: boolean; github: Promise<GithubReachability> },
  ): Promise<DoctorCheck> {
    const { probes } = this.deps;
    const withRemote = (await discovery)
      .filter((repo) => repo.remoteUrl)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (withRemote.length === 0) return remoteCheck([]);
    const tasks = remotes.all
      ? []
      : await this.deps.tasks.listTasks().catch(() => []);
    const scope = selectRemoteProbes(withRemote, tasks, { all: remotes.all });
    if (scope.probe.length === 0) return remoteCheck([], scope);
    const github = scope.probe.some((repo) => onGithub(repo.id))
      ? await remotes.github
      : "unknown";
    const results = new Map<string, RemoteResult>();
    const toProbe = scope.probe.filter((repo) => {
      if (github !== "unreachable" || !onGithub(repo.id)) return true;
      results.set(repo.id, {
        id: repo.id,
        root: repo.root,
        skipped: "api.github.com unreachable",
      });
      return false;
    });
    const rounds = Math.ceil(toProbe.length / NETWORK_PROBE_CONCURRENCY);
    await guardedWait(
      forEachConcurrently(toProbe, NETWORK_PROBE_CONCURRENCY, async (repo) => {
        const probe: RemoteProbe = await probes
          .remoteReachable(repo.root)
          .catch((error: unknown) => ({
            ok: false,
            timedOut: false,
            error: describe(error),
          }));
        results.set(repo.id, { id: repo.id, root: repo.root, probe });
      }),
      rounds * NETWORK_PROBE_TIMEOUT_MS + GUARD_SLACK_MS,
    );
    return remoteCheck(
      scope.probe.map(
        (repo) =>
          results.get(repo.id) ?? {
            id: repo.id,
            root: repo.root,
            probe: { ok: false, timedOut: true },
          },
      ),
      scope,
    );
  }
}

/** Waits for `work` at most `ms` (the probes inside have their own timeouts). */
async function guardedWait(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function configCheckInput(
  state: ConfigState,
): Parameters<typeof configCheck>[0] {
  if ("missing" in state) return { missing: true, path: state.path };
  if ("error" in state) return { error: state.error, path: state.path };
  return {
    path: state.path,
    codeRoot: state.config.codeRoot,
    defaultHarness: state.config.launch?.defaultHarness ?? DEFAULT_HARNESS_ID,
    customAgents: state.config.agents?.custom?.length ?? 0,
  };
}
