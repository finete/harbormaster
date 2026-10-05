// Harness adapter seam (see /docs/design-decisions.md #13 and /AGENTS.md:
// "Agent harnesses are adapters"). Anything agent-specific — session
// spawn/attach, presence, running-detection — lives behind this interface so
// core logic never imports Pi (or Claude Code, Codex, ...) directly.
//
// Phase 1 ships only the seam: no implementation anywhere in this package.
// A Pi-backed implementation (the only adapter v1 needs) is phase 2.

import type { PresenceRecord } from "./model.js";

export interface SpawnSessionInput {
  taskId: string;
  /** Working directory the session's process runs in. */
  cwd: string;
  initialPrompt: string;
  title?: string;
}

export interface SessionHandle {
  sessionPath: string;
  pid: number;
}

/**
 * One agent harness (Pi today; Claude Code/Codex/etc. later). Every method
 * is a phase 2 TODO — the interface exists now so Manager-level code can be
 * written against it without waiting for an implementation.
 */
export interface HarnessAdapter {
  /** Start a fresh agent session for a task. // phase 2 */
  spawnSession(input: SpawnSessionInput): Promise<SessionHandle>;

  /** Attach the caller to an already-running task session. // phase 2 */
  attach(taskId: string): Promise<void>;

  /** Current liveness/outcome record for a task's session, if any. // phase 2 */
  presence(taskId: string): Promise<PresenceRecord | undefined>;

  /** Whether a previously spawned process still exists. // phase 2 */
  isRunning(pid: number): boolean;
}
