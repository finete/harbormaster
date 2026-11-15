// Manager helper: the `doctor` use case (`CoreCommands.doctor`), kept out
// of core-manager.ts like the rules runtime. Sequences the read-only probes
// (`EnvironmentProbeAccess`, the state accessors' read verbs) and hands the
// raw facts to `engines/doctor.ts` for the verdicts. Never writes: a missing
// config is reported, not created, and rules are parsed without the
// managed-file / default-rules writes `listRules` does, so the CLI can run
// this against a state dir while the app is down. Every check is bounded by
// a timeout and never throws (a probe that fails reports `skip`).

import type { OrphanWorktreeReport } from "../contracts/commands.js";
import {
  DOCTOR_PROBE_TIMEOUT_MS,
  type DoctorCheck,
  type DoctorInput,
  type DoctorReport,
  type EnvironmentProbeAccess,
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
  githubAuthCheck,
  loginShellPathCheck,
  orderDoctorChecks,
  orphansCheck,
  piExtensionCheck,
  type RemoteResult,
  remoteCheck,
  rulesCheck,
  skippedCheck,
  socketCheck,
  stateFileCheck,
} from "../engines/doctor.js";
import { parseRuleFile } from "../engines/rules/rule-files.js";
import { forEachConcurrently } from "../utilities/concurrency.js";

/** Remote probes in flight at once. */
const REMOTE_CONCURRENCY = 8;

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

/** `work` within `ms`; a throw or a timeout becomes a `skip` check for `id`. */
async function guarded(
  id: string,
  ms: number,
  work: () => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DoctorTimeout()), ms);
      }),
    ]);
  } catch (error) {
    return skippedCheck(
      id,
      error instanceof DoctorTimeout
        ? `Timed out after ${Math.round(ms / 1000)} s`
        : `Could not check: ${describe(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
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
    const probe = DOCTOR_PROBE_TIMEOUT_MS + 1_000;

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
      guarded("tools.gh-auth", probe, async () =>
        githubAuthCheck(await probes.githubAuthStatus(), githubEnabled),
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
      Promise.resolve(configCheck(configCheckInput(configState))),
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
      ...this.repositoryChecks(config),
      config
        ? guarded("worktrees.orphans", DOCTOR_SCAN_TIMEOUT_MS, async () =>
            orphansCheck(await this.deps.orphans()),
          )
        : Promise.resolve(
            skippedCheck("worktrees.orphans", "No usable config.json"),
          ),
      guarded("disk.free", probe, async () => {
        const disk = await probes.stateDirFreeBytes();
        return diskCheck(disk.freeBytes, disk.path);
      }),
      guarded("socket.tool", probe, async () =>
        socketCheck(await probes.toolSocket()),
      ),
      Promise.resolve(
        loginShellPathCheck(input.loginShellPath, probes.processPath()),
      ),
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
  ): Array<Promise<DoctorCheck>> {
    if (!config) {
      return ["repos.codeRoot", "repos.discovered", "repos.remote"].map((id) =>
        Promise.resolve(skippedCheck(id, "No usable config.json")),
      );
    }
    const { probes } = this.deps;
    const codeRoot = config.codeRoot;
    const discovery = this.deps.repositories(config);
    // Settled here so a rejected discovery is never an unhandled rejection
    // while one of the checks is still waiting on another probe.
    discovery.catch(() => {});
    const remoteBudget = (count: number): number =>
      (Math.ceil(count / REMOTE_CONCURRENCY) + 1) * DOCTOR_PROBE_TIMEOUT_MS;
    return [
      guarded("repos.codeRoot", DOCTOR_PROBE_TIMEOUT_MS + 1_000, async () =>
        codeRootCheck(
          codeRoot,
          codeRoot ? await probes.pathFacts(codeRoot) : undefined,
        ),
      ),
      guarded("repos.discovered", DOCTOR_SCAN_TIMEOUT_MS, async () =>
        discoveredCheck((await discovery).length, codeRoot),
      ),
      guarded("repos.remote", DOCTOR_SCAN_TIMEOUT_MS * 3, async () => {
        const withRemote = (await discovery).filter((repo) => repo.remoteUrl);
        const results: RemoteResult[] = [];
        const remotes = forEachConcurrently(
          withRemote,
          REMOTE_CONCURRENCY,
          async (repo) => {
            results.push({
              id: repo.id,
              root: repo.root,
              probe: await probes.remoteReachable(repo.root),
            });
          },
        );
        await guardedWait(remotes, remoteBudget(withRemote.length));
        for (const repo of withRemote) {
          if (results.some((result) => result.id === repo.id)) continue;
          results.push({
            id: repo.id,
            root: repo.root,
            probe: { ok: false, timedOut: true },
          });
        }
        return remoteCheck(results.sort((a, b) => a.id.localeCompare(b.id)));
      }),
    ];
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
