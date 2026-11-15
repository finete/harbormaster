// Manager helper: the post-launch session-file confirmation. A `new`
// session launch arms a pending check (where the harness should create the
// file); `checkPendingSessionFiles()` (called once per app presence-poll
// tick) looks once the grace window has passed and logs
// `[core:session] no session file appeared for task …` when nothing is
// there. Decisions are the pure engine's (engines/session-file-check.ts);
// the look-up is SessionFileAccess's. In-memory only: a restart forgets
// pending checks, which is fine for a diagnostic line.

import type { CoreLogger } from "../contracts/logger.js";
import type { SessionFileAccess } from "../contracts/services.js";
import {
  dueSessionFileChecks,
  type PendingSessionFile,
  sessionFileCheckWarning,
} from "../engines/session-file-check.js";

/** Pending checks kept at most (oldest dropped): a runaway launch loop must not grow this forever. */
const MAX_PENDING = 200;

export class SessionFileWatch {
  private readonly pending = new Map<string, PendingSessionFile>();

  constructor(
    private readonly deps: {
      sessions: SessionFileAccess;
      logger: CoreLogger;
      nowMs: () => number;
    },
  ) {}

  /** Start waiting for `entry`'s file (replaces an earlier check for the same task). */
  arm(entry: Omit<PendingSessionFile, "armedAtMs">): void {
    this.pending.delete(entry.taskId);
    this.pending.set(entry.taskId, { ...entry, armedAtMs: this.deps.nowMs() });
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  /** The harness reported the session's exact file: check that file instead of the directory. */
  reported(taskId: string, sessionId: string, sessionFile: string): void {
    const entry = this.pending.get(taskId);
    if (entry?.sessionId === sessionId) {
      this.pending.set(taskId, { ...entry, sessionFile });
    }
  }

  /** Run every due check once (and drop it); returns how many found no file. */
  async check(): Promise<number> {
    let missing = 0;
    for (const entry of dueSessionFileChecks(
      this.pending.values(),
      this.deps.nowMs(),
    )) {
      this.pending.delete(entry.taskId);
      const found = await this.find(entry);
      const warning = sessionFileCheckWarning(entry, found);
      if (!warning) continue;
      missing += 1;
      this.deps.logger.warn("session", warning, {
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        outcome: "missing",
        ...(entry.sessionFile
          ? { sessionFile: entry.sessionFile }
          : entry.dir
            ? { sessionDir: entry.dir }
            : {}),
      });
    }
    return missing;
  }

  /** Pending check count (tests, diagnostics). */
  get size(): number {
    return this.pending.size;
  }

  private async find(entry: PendingSessionFile): Promise<boolean> {
    try {
      if (entry.sessionFile) {
        return await this.deps.sessions.exists(entry.sessionFile);
      }
      if (entry.dir && entry.fileSuffix && this.deps.sessions.findSessionFile) {
        return Boolean(
          await this.deps.sessions.findSessionFile(entry.dir, entry.fileSuffix),
        );
      }
    } catch {
      return false;
    }
    // Nowhere to look: no warning (sessionFileCheckWarning needs a place).
    return true;
  }
}
