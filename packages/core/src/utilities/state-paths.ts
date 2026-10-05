// Per-user state directory layout. Default `~/.harbormaster`; every access
// service takes its path from here and nothing else resolves paths itself.

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STATE_DIR = join(homedir(), ".harbormaster");

export interface StatePaths {
  readonly root: string;
  readonly tasksFile: string;
  readonly tasksLockFile: string;
  readonly workspaceBindingsFile: string;
  readonly workspaceBindingsLockFile: string;
  readonly configFile: string;
  readonly presenceDir: string;
}

export function resolveStatePaths(
  stateDir: string = DEFAULT_STATE_DIR,
): StatePaths {
  return {
    root: stateDir,
    tasksFile: join(stateDir, "tasks.json"),
    tasksLockFile: join(stateDir, "tasks.lock"),
    workspaceBindingsFile: join(stateDir, "workspace-bindings.json"),
    workspaceBindingsLockFile: join(stateDir, "workspace-bindings.lock"),
    configFile: join(stateDir, "config.json"),
    presenceDir: join(stateDir, "presence"),
  };
}
