// Harbormaster core — command API lives here. See /AGENTS.md and /docs/design-decisions.md.
//
// `createCore()` is the one entry point frontends use: commands in, state
// events out. No Electron, filesystem-layout assumption beyond a
// constructor-injected state directory, or process assumption leaks through
// this boundary — it must stay daemon-ready (see /ai/prds/architecture.md).

import {
  JsonConfigAccess,
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  SessionPresenceAccess,
} from "./access/index.js";
import type { CoreCommands } from "./contracts/commands.js";
import type { CoreEvents } from "./contracts/events.js";
import type { Clock, IdGenerator } from "./contracts/services.js";
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
export * from "./utilities/index.js";

export interface CoreOptions {
  /** Per-user state directory; defaults to `~/.harbormaster`. Constructor-injected so tests use a temp dir. */
  stateDir?: string;
  clock?: Clock;
  ids?: IdGenerator;
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
  // Phase 2 seams: constructed and ready for the Manager to grow into, but
  // nothing in the phase 1 command surface reads or writes them yet.
  const workspaceBindings = new JsonWorkspaceBindingAccess(
    paths.workspaceBindingsFile,
    paths.workspaceBindingsLockFile,
  );
  const presence = new SessionPresenceAccess(paths.presenceDir);
  const config = new JsonConfigAccess(paths.configFile);
  void workspaceBindings;
  void presence;
  void config;

  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidGenerator();
  const events = new CoreEventBus();

  const commands = new CoreManager({ tasks: taskState, clock, ids, events });

  return { commands, events };
}
