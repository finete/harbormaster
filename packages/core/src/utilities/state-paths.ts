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
  /** Root for `launchTask` `{ none: true }` scratch directories: `<stateDir>/scratch/<taskId>`. */
  readonly scratchDir: string;
  /** `<stateDir>/locations.json`: folders registered outside `codeRoot` (composer "Open folder…"). */
  readonly locationsFile: string;
  /** `<stateDir>/task-attachments/<taskId>/`: copies of images pasted into a task's prompt. */
  readonly taskAttachmentsDir: string;
  /** Task-messaging storage root: `<stateDir>/messages`. */
  readonly messagesDir: string;
  /** `<stateDir>/messages/messages.json`: the message log + last user inputs. */
  readonly messagesFile: string;
  readonly messagesLockFile: string;
  /** `<stateDir>/messages/doorbell/<taskId>`: touched when a task's inbox changes. */
  readonly doorbellDir: string;
  /** `<stateDir>/messages/attachments/<messageId>/`: core's copies of message attachments. */
  readonly attachmentsDir: string;
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
    scratchDir: join(stateDir, "scratch"),
    locationsFile: join(stateDir, "locations.json"),
    taskAttachmentsDir: join(stateDir, "task-attachments"),
    messagesDir: join(stateDir, "messages"),
    messagesFile: join(stateDir, "messages", "messages.json"),
    messagesLockFile: join(stateDir, "messages", "messages.lock"),
    doorbellDir: join(stateDir, "messages", "doorbell"),
    attachmentsDir: join(stateDir, "messages", "attachments"),
  };
}
