// Harbormaster core — command API lives here. See /AGENTS.md and /docs/design-decisions.md.
//
// `createCore()` is the one entry point frontends use: commands in, state
// events out. No Electron, filesystem-layout assumption beyond a
// constructor-injected state directory, or process assumption leaks through
// this boundary — it must stay daemon-ready (see /docs/design-decisions.md "Layering").

import {
  GithubPrAccess,
  HttpVersionAccess,
  JsonConfigAccess,
  JsonFolderAccess,
  JsonMessageAccess,
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  LocalGitRepositoryAccess,
  LocalGitWorktreeAccess,
  LocalScratchWorkspaceAccess,
  LocalSessionFileAccess,
  LocalTaskAttachmentAccess,
  SessionPresenceAccess,
} from "./access/index.js";
import type { CoreCommands } from "./contracts/commands.js";
import type { CoreEvents } from "./contracts/events.js";
import type { PullRequestAccess, VersionAccess } from "./contracts/github.js";
import type { HarnessAdapter } from "./contracts/harness.js";
import type { Clock, IdGenerator } from "./contracts/services.js";
import { PiHarnessAdapter } from "./harness/pi-adapter.js";
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
export * from "./migration/index.js";
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
}

/** The transport-ready facade: commands in, state events out. */
export interface Core {
  commands: CoreCommands;
  events: CoreEvents;
}

export function createCore(options: CoreOptions = {}): Core {
  const paths = resolveStatePaths(options.stateDir ?? DEFAULT_STATE_DIR);

  const taskState = new JsonTaskStateAccess(
    paths.tasksFile,
    paths.tasksLockFile,
  );
  const workspaceBindings = new JsonWorkspaceBindingAccess(
    paths.workspaceBindingsFile,
    paths.workspaceBindingsLockFile,
  );
  // Presence is a phase-2 seam: constructed and ready to grow into, but
  // nothing in the command surface reads or writes it yet.
  const presence = new SessionPresenceAccess(paths.presenceDir);
  void presence;
  const config = new JsonConfigAccess(paths.configFile);
  const repositories = new LocalGitRepositoryAccess();
  const worktrees = new LocalGitWorktreeAccess();
  const scratch = new LocalScratchWorkspaceAccess(paths.scratchDir);
  const pullRequests = options.pullRequests ?? new GithubPrAccess();
  const versions = options.versions ?? new HttpVersionAccess();

  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidGenerator();
  const events = new CoreEventBus();
  const messages = new JsonMessageAccess(paths);
  const folders = new JsonFolderAccess(paths.locationsFile);
  const attachments = new LocalTaskAttachmentAccess(paths.taskAttachmentsDir);
  const harness =
    options.harness ?? new PiHarnessAdapter({ stateDir: paths.root, clock });

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
    pullRequests,
    versions,
    messages,
    harness,
    folders,
    attachments,
  });

  return { commands, events };
}
