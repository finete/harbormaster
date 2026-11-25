// Harbormaster core — command API lives here. See /AGENTS.md and /docs/design-decisions.md.
//
// `createCore()` is the one entry point frontends use: commands in, state
// events out. No Electron, filesystem-layout assumption beyond a
// constructor-injected state directory, or process assumption leaks through
// this boundary — it must stay daemon-ready (see /docs/design-decisions.md "Layering").

import { homedir } from "node:os";
import {
  AgentProcessAccess,
  ClaudeSessionsReader,
  CodexSessionsReader,
  CursorChatsReader,
  GithubPrAccess,
  HttpVersionAccess,
  ImportHerdrAccess,
  JsonConfigAccess,
  JsonFolderAccess,
  JsonInboxAccess,
  JsonlAuditLogAccess,
  JsonMessageAccess,
  JsonSourceStateAccess,
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  LocalAddonAccess,
  LocalEnvironmentProbeAccess,
  LocalGitRepositoryAccess,
  LocalGitWorktreeAccess,
  LocalLaunchFilesAccess,
  LocalOnboardingProbeAccess,
  LocalReviewSupportProbeAccess,
  LocalRulesFileAccess,
  LocalScratchWorkspaceAccess,
  LocalSessionFileAccess,
  LocalTaskAttachmentAccess,
  PiSessionsReader,
  SessionPresenceAccess,
  timedPullRequestAccess,
  timedWorktreeAccess,
} from "./access/index.js";
import type { CoreCommands } from "./contracts/commands.js";
import type { EnvironmentProbeAccess } from "./contracts/doctor.js";
import type { CoreEvents } from "./contracts/events.js";
import type { PullRequestAccess, VersionAccess } from "./contracts/github.js";
import type { HarnessAdapter } from "./contracts/harness.js";
import type {
  ImportProcessAccess,
  ImportSourceReader,
} from "./contracts/import.js";
import { type CoreLogger, noopCoreLogger } from "./contracts/logger.js";
import type { OnboardingProbeAccess } from "./contracts/onboarding.js";
import type {
  Clock,
  IdGenerator,
  ReviewSupportProbeAccess,
} from "./contracts/services.js";
import { PiHarnessAdapter } from "./harness/pi-adapter.js";
import { createHarnessRegistry, HarnessRegistry } from "./harness/registry.js";
import { CoreManager } from "./manager/core-manager.js";
import { SystemClock, UuidGenerator } from "./utilities/defaults.js";
import { CoreEventBus } from "./utilities/event-bus.js";
import {
  DEFAULT_STATE_DIR,
  resolveStatePaths,
} from "./utilities/state-paths.js";

export * from "./access/index.js";
export * from "./contracts/index.js";
export * from "./engines/index.js";
export * from "./harness/index.js";
export * from "./manager/index.js";
export * from "./tools/index.js";
export * from "./transport/index.js";
export * from "./utilities/index.js";

export interface CoreOptions {
  /** Per-user state directory; defaults to `~/.harbormaster`. Constructor-injected so tests use a temp dir. */
  stateDir?: string;
  clock?: Clock;
  ids?: IdGenerator;
  /** Overrides the gh-CLI-backed GitHub access; tests inject a fake `Execute` here instead of `GithubPrAccess()`'s default real `gh`. */
  pullRequests?: PullRequestAccess;
  /** Overrides the HTTPS version-endpoint access; tests inject a fake fetch here instead of `HttpVersionAccess()`'s default real `fetch`. */
  versions?: VersionAccess;
  /** Overrides the Pi harness adapter (presence + messaging capabilities); tests inject a fake presence/capabilities here. Defaults to a `PiHarnessAdapter` on the same state dir and clock. */
  harness?: HarnessAdapter;
  /**
   * Overrides the agent registry (per-task messaging capabilities, model
   * catalogs). Defaults to the built-ins (Pi, Claude Code) on the same
   * presence registry; with only `harness` set, that one adapter serves
   * every task.
   */
  harnesses?: HarnessRegistry;
  /** Overrides the onboarding wizard's machine probes (home folder, `--version`, `gh auth status`); tests inject fakes. */
  onboarding?: OnboardingProbeAccess;
  /**
   * Operation log: timed git/GitHub/worktree spans, session-launch
   * decisions, state migrations, launch transitions (see
   * contracts/logger.ts). The app passes `consoleCoreLogger(console)`;
   * absent, core logs nothing.
   */
  logger?: CoreLogger;
  /** Overrides `doctor`'s machine probes; tests inject fakes. */
  environment?: EnvironmentProbeAccess;
  /** The Pi extension source the host bundles, compared by `doctor`'s `agents.pi-extension` check. */
  piExtensionSource?: string;
  /**
   * Absolute path of the host's open-url handler script (docs/plannotator.md
   * "Transport"), handed out by `getLaunchSettings` so launch specs export
   * it as `PLANNOTATOR_BROWSER` (and `BROWSER` with `captureAgentBrowser`).
   */
  openUrlHandler?: string;
  /** Overrides `reviewSupport`'s Plannotator version probes; tests inject fakes. */
  reviewProbes?: ReviewSupportProbeAccess;
  /**
   * Watch config.json for hand edits (docs/settings.md S4): the long-lived
   * host (the app) sets it; one-shot clients (the CLI) leave it off.
   * Stopped by `Core.close()`.
   */
  watchConfig?: boolean;
  /**
   * Import existing work (docs/import.md). `home` points EVERY built-in
   * reader (Pi, Claude Code, Codex, Cursor, herdr) and the process access at
   * one home folder instead of the user's own (tests and e2e use it; the app
   * maps its environment variables to it). `readers` replaces the built-in
   * reader list; `extraReaders` adds to it (a future orchestrator);
   * `processes` replaces the `ps` / `lsof` process access.
   */
  import?: {
    home?: string;
    readers?: ImportSourceReader[];
    extraReaders?: ImportSourceReader[];
    processes?: ImportProcessAccess;
  };
}

/** The transport-ready facade: commands in, state events out. */
export interface Core {
  commands: CoreCommands;
  events: CoreEvents;
  /** Shutdown: stop core's own watchers (config.json). Idempotent. */
  close(): void;
}

export function createCore(options: CoreOptions = {}): Core {
  const paths = resolveStatePaths(options.stateDir ?? DEFAULT_STATE_DIR);
  const logger = options.logger ?? noopCoreLogger;

  const taskState = new JsonTaskStateAccess(
    paths.tasksFile,
    paths.tasksLockFile,
    logger,
  );
  const workspaceBindings = new JsonWorkspaceBindingAccess(
    paths.workspaceBindingsFile,
    paths.workspaceBindingsLockFile,
  );
  // Written by the presence commands (`reportPresence` / `endPresence` /
  // `reportTaskOutcome`); read through the harness adapter.
  const presence = new SessionPresenceAccess(paths.presenceDir);
  const config = new JsonConfigAccess(paths.configFile);
  const repositories = new LocalGitRepositoryAccess();
  const worktrees = timedWorktreeAccess(
    new LocalGitWorktreeAccess(paths.worktreesDir),
    logger,
  );
  const scratch = new LocalScratchWorkspaceAccess(paths.scratchDir);
  const pullRequests = timedPullRequestAccess(
    options.pullRequests ?? new GithubPrAccess(),
    logger,
  );
  const versions = options.versions ?? new HttpVersionAccess();

  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidGenerator();
  const events = new CoreEventBus();
  const messages = new JsonMessageAccess(paths);
  const folders = new JsonFolderAccess(paths.locationsFile);
  const attachments = new LocalTaskAttachmentAccess(paths.taskAttachmentsDir);
  const harness =
    options.harness ??
    new PiHarnessAdapter({ stateDir: paths.root, clock, presence });
  const harnesses =
    options.harnesses ??
    (options.harness
      ? new HarnessRegistry([options.harness], { fallback: options.harness })
      : createHarnessRegistry({ stateDir: paths.root, clock, presence }));

  const importHome = options.import?.home;
  const homeOption = importHome ? { home: importHome } : {};
  const importReaders = options.import?.readers ?? [
    new PiSessionsReader(homeOption),
    new ClaudeSessionsReader(homeOption),
    new CodexSessionsReader(homeOption),
    new CursorChatsReader(homeOption),
    new ImportHerdrAccess(homeOption),
    ...(options.import?.extraReaders ?? []),
  ];

  const commands = new CoreManager({
    tasks: taskState,
    clock,
    ids,
    events,
    config,
    repositories,
    worktrees,
    bindings: workspaceBindings,
    sessions: new LocalSessionFileAccess(),
    scratch,
    launchFiles: new LocalLaunchFilesAccess(paths),
    pullRequests,
    versions,
    messages,
    harness,
    harnesses,
    folders,
    attachments,
    presence,
    rules: {
      files: new LocalRulesFileAccess(paths.rulesDir),
      state: new JsonSourceStateAccess(paths.sourcesDir),
      audit: new JsonlAuditLogAccess(paths.eventsDir),
      addons: new LocalAddonAccess(paths.addonsDir),
    },
    inbox: new JsonInboxAccess(paths.inboxFile, paths.inboxLockFile),
    onboarding: options.onboarding ?? new LocalOnboardingProbeAccess(),
    logger,
    environment:
      options.environment ??
      new LocalEnvironmentProbeAccess({
        paths,
        ...(options.piExtensionSource
          ? { piExtensionSource: options.piExtensionSource }
          : {}),
      }),
    reviewProbes: options.reviewProbes ?? new LocalReviewSupportProbeAccess(),
    importReaders,
    importProcesses:
      options.import?.processes ?? new AgentProcessAccess(homeOption),
    importHome: importHome ?? homedir(),
    worktreesRoot: paths.worktreesDir,
    ...(options.openUrlHandler
      ? { openUrlHandler: options.openUrlHandler }
      : {}),
  });

  if (options.watchConfig) commands.watchConfig();
  return { commands, events, close: () => commands.dispose() };
}
