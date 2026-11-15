// Engine: did the harness actually create the session file a `new` launch
// promised? Pure decisions only; the watch list lives in the Manager
// (manager/session-file-watch.ts) and the directory look-up in Resource
// Access (`SessionFileAccess.findSessionFile`).
//
// Why: a launched task whose agent never wrote its session file used to go
// unnoticed (the board showed a task, the pane had nothing to resume).

import type { SessionLaunch } from "../contracts/harness.js";

/** How long a harness gets to create a `new` session's file before core warns. */
export const SESSION_FILE_GRACE_MS = 20_000;

/** One `new` launch waiting for its session file. */
export interface PendingSessionFile {
  taskId: string;
  sessionId: string;
  /** Directory the harness is expected to create the file in. */
  dir?: string;
  /** File-name suffix that identifies the session in `dir` (Pi: `_<id>.jsonl`). */
  fileSuffix?: string;
  /** The exact file, once the harness reported it (`recordTaskSession`). */
  sessionFile?: string;
  /** When the launch was decided (epoch ms). */
  armedAtMs: number;
}

/** Whether a session launch decision should be followed by a file check. */
export function shouldWatchSessionFile(
  launch: SessionLaunch | undefined,
  hasInitialPrompt: boolean,
): launch is Extract<SessionLaunch, { mode: "new" }> {
  // Pi (like Claude Code) only writes the file once the conversation has a
  // message: a `new` session opened without a prompt legitimately stays
  // file-less until the user types, so only a prompted launch is checked.
  return launch?.mode === "new" && hasInitialPrompt;
}

/** The pending checks whose grace window has passed at `nowMs`. */
export function dueSessionFileChecks(
  pending: Iterable<PendingSessionFile>,
  nowMs: number,
  graceMs: number = SESSION_FILE_GRACE_MS,
): PendingSessionFile[] {
  return [...pending].filter((entry) => nowMs - entry.armedAtMs >= graceMs);
}

/**
 * The warning for a due check, or `undefined` when the file is there (or
 * there is nowhere to look).
 */
export function sessionFileCheckWarning(
  entry: PendingSessionFile,
  found: boolean,
): string | undefined {
  if (found) return undefined;
  const where = entry.sessionFile ?? entry.dir;
  if (!where) return undefined;
  return `no session file appeared for task ${entry.taskId} (expected under ${where})`;
}
