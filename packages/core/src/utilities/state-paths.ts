// Per-user state directory layout. Default `~/.harbormaster`; every access
// service takes its path from here and nothing else resolves paths itself.

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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
  /** Task worktrees root: `<stateDir>/worktrees/<repo-folder>/<branch-slug>`. */
  readonly worktreesDir: string;
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
  /** The app's local tool socket (see `resolveSocketPath`). */
  readonly socketFile: string;
  /** `<stateDir>/rules/`: `rules.yaml`, `repos/<repository id>.yaml`, JS escape-hatch modules. */
  readonly rulesDir: string;
  /** `<stateDir>/sources/`: last snapshot + cursor per event source, the pending-move queue. */
  readonly sourcesDir: string;
  /** `<stateDir>/events/`: the rules audit log, `YYYY-MM-DD.jsonl`. */
  readonly eventsDir: string;
  /** `<stateDir>/addons/<name>/`: user addons (`addon.json` + `source.mjs`). */
  readonly addonsDir: string;
  /** `<stateDir>/inbox/items.json`: persisted inbox items. */
  readonly inboxFile: string;
  readonly inboxLockFile: string;
}

/** Unix socket paths are capped (104 bytes on macOS); stay safely under it. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Where the app's local tool socket lives for a state dir:
 * `<stateDir>/harbormaster.sock`, or, when that path is too long for a unix
 * socket (deep temp dirs), `<tmpdir>/harbormaster-<hash of stateDir>.sock`.
 * Server and clients derive it the same way, so no lookup file is needed.
 */
export function resolveSocketPath(
  stateDir: string = DEFAULT_STATE_DIR,
): string {
  const preferred = join(stateDir, "harbormaster.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  const fallback = join(tmpdir(), `harbormaster-${hash}.sock`);
  if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) return fallback;
  return join("/tmp", `harbormaster-${hash}.sock`);
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
    worktreesDir: join(stateDir, "worktrees"),
    locationsFile: join(stateDir, "locations.json"),
    taskAttachmentsDir: join(stateDir, "task-attachments"),
    messagesDir: join(stateDir, "messages"),
    messagesFile: join(stateDir, "messages", "messages.json"),
    messagesLockFile: join(stateDir, "messages", "messages.lock"),
    doorbellDir: join(stateDir, "messages", "doorbell"),
    attachmentsDir: join(stateDir, "messages", "attachments"),
    socketFile: resolveSocketPath(stateDir),
    rulesDir: join(stateDir, "rules"),
    sourcesDir: join(stateDir, "sources"),
    eventsDir: join(stateDir, "events"),
    addonsDir: join(stateDir, "addons"),
    inboxFile: join(stateDir, "inbox", "items.json"),
    inboxLockFile: join(stateDir, "inbox", "items.lock"),
  };
}
