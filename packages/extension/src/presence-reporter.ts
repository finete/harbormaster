// Pure-ish presence lifecycle: wraps @harbormaster/core's PresenceAccess
// with the attachment bookkeeping a hosted Pi session needs (one writer per
// process, re-registration on session switch, turn-state tracking). Ported
// from pi-home's src/index.ts closures (attachment/attachmentReady/
// turnActive) into a small, independently testable class — the extension's
// only business logic, everything else in src/index.ts is wiring to the pi
// extension API.

import type { PresenceAccess, PresenceMode } from "@harbormaster/core";

export interface PresenceReporterOptions {
  presence: PresenceAccess;
  /** This process's pid — presence mutations are pid-scoped (see PresenceAccess). */
  pid: number;
  /** Injectable clock for tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

export interface StartSessionInput {
  taskId: string;
  sessionPath: string;
  mode: PresenceMode;
}

/**
 * Tracks one Pi process's presence attachment to a Harbormaster task.
 * Registration is async (a file write); turn events can arrive while it is
 * still in flight, so the intended turn state is tracked independently and
 * reconciled once the attachment resolves, instead of dropping the signal.
 */
export class PresenceReporter {
  private attachment: { taskId: string; pid: number } | undefined;
  /** The agent loop is running (agent_start..agent_end). */
  private loopActive = false;
  /**
   * Pi is blocked on a user-facing extension UI prompt (a `ctx.ui.select` /
   * `confirm` / `input` / `editor` prompt — e.g. the commit gate). The loop
   * is technically still open, but nothing proceeds until the user acts, so
   * the task is "your move", not "working".
   */
  private promptPending = false;
  private registering: Promise<void> = Promise.resolve();

  /**
   * Effective running-turn state reported to presence: the agent is only
   * "working" when its loop is active AND it is not parked on a user prompt.
   */
  private get effectiveRunning(): boolean {
    return this.loopActive && !this.promptPending;
  }

  constructor(private readonly options: PresenceReporterOptions) {}

  private nowIso(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }

  /** Whether this reporter currently believes it owns a live presence record. */
  get isAttached(): boolean {
    return !!this.attachment;
  }

  /**
   * Register presence for a session that just started (or switched). Ends
   * any prior attachment first — a session switch is a new attachment, not
   * an update to the old one.
   */
  async start(input: StartSessionInput): Promise<void> {
    const job = this.registerInternal(input);
    this.registering = job.then(
      () => undefined,
      () => undefined,
    );
    await job;
  }

  private async registerInternal(input: StartSessionInput): Promise<void> {
    await this.end();
    await this.options.presence.register({
      taskId: input.taskId,
      sessionPath: input.sessionPath,
      pid: this.options.pid,
      mode: input.mode,
      at: this.nowIso(),
    });
    this.attachment = { taskId: input.taskId, pid: this.options.pid };
    // Apply any turn that started while registration was in flight. A fresh
    // attachment is idle by construction (register() seeds runningTurn
    // itself), so there is nothing to reconcile when the effective state is
    // not running — including the case of a prompt already pending at start.
    if (this.effectiveRunning) await this.applyTurnState();
  }

  /** Refresh the heartbeat for the current attachment, if any. */
  async heartbeat(): Promise<void> {
    await this.registering;
    if (!this.attachment) return;
    await this.options.presence.heartbeat(
      this.attachment.taskId,
      this.attachment.pid,
      this.nowIso(),
    );
  }

  /** Record an agent-loop boundary (agent started/stopped working). */
  async setTurnActive(active: boolean): Promise<void> {
    this.loopActive = active;
    await this.registering;
    await this.applyTurnState();
  }

  /**
   * Record that Pi started/stopped waiting on a blocking user-facing UI
   * prompt. While pending, the task reads as "your move" even though the
   * agent loop is still open; clearing it restores the loop's running state.
   */
  async setPromptPending(pending: boolean): Promise<void> {
    this.promptPending = pending;
    await this.registering;
    await this.applyTurnState();
  }

  private async applyTurnState(): Promise<void> {
    if (!this.attachment) return;
    await this.options.presence.setTurnActive(
      this.attachment.taskId,
      this.attachment.pid,
      this.effectiveRunning,
      this.nowIso(),
    );
  }

  /** End the current attachment (session switch or shutdown). A no-op if nothing is attached. */
  async end(): Promise<void> {
    const current = this.attachment;
    this.attachment = undefined;
    if (current) {
      await this.options.presence.end(
        current.taskId,
        current.pid,
        this.nowIso(),
      );
    }
  }
}
