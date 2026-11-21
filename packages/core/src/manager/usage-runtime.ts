// Manager helper: per-task token usage (docs/costs.md "Adapter parses, core
// persists"). Finds a task's session files (binding `sessionPath` +
// `previousSessionPath`, the bound session id resolved through the
// adapter's `expectedSessionFile`, and sessions already counted), has the
// task's harness adapter read them, sums them with the pure usage engine
// and persists `task.usage`. Triggers live in CoreManager (session
// recorded, agent finished/outcome, Done, the refresh's pending re-check
// and backfill drain, `refreshTaskUsage`). Never throws into those commands: a failure is
// logged and the previous usage stays.

import type { HarnessAdapter } from "../contracts/harness.js";
import type { CoreLogger } from "../contracts/logger.js";
import type { Task, WorkspaceBinding } from "../contracts/model.js";
import type {
  Clock,
  SessionFileAccess,
  TaskStateAccess,
} from "../contracts/services.js";
import type { SessionUsage, TaskUsage } from "../contracts/usage.js";
import {
  awaitsUsageBackfill,
  lastActivityFromStats,
  placeholderUsage,
  summarizeTaskUsage,
  usageFingerprint,
} from "../engines/usage.js";
import { forEachConcurrently } from "../utilities/concurrency.js";
import { logErrorMessage } from "../utilities/timed.js";

/** Tasks per backfill-drain batch: one board push per batch at most. */
const DRAIN_BATCH = 16;
const BACKFILL_CONCURRENCY = 4;
/**
 * The refresh tick re-parses a counted task's changed files only once the
 * newest has been quiet this long: a working agent's transcript changes on
 * nearly every tick, and the parse is synchronous on the app's main process
 * (~2.5 ms per MB). Turn ends recount right away (a `stop` boundary).
 */
const TICK_QUIET_MS = 15_000;

/** Let other work (IPC, timers, a refresh) run between drain batches. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface UsageRuntimeDeps {
  tasks: TaskStateAccess;
  sessions: SessionFileAccess;
  clock: Clock;
  logger: CoreLogger;
  /**
   * The task's harness adapter; `"unsupported"` when its agent is no longer
   * registered (a removed custom CLI), `undefined` when no harness is
   * configured at all.
   */
  adapterFor(task: Task): Promise<HarnessAdapter | "unsupported" | undefined>;
  /** Current binding of a task (live read). */
  bindingFor(taskId: string): Promise<WorkspaceBinding | undefined>;
  /** Emit `task-changed` (+ board) for a task whose usage changed. */
  publish(task: Task): Promise<void>;
}

export interface UpdateUsageOptions {
  /** Re-read even when no session file changed (the popover's refresh). */
  force?: boolean;
  /** The binding as it was before a Done parked it (its `worktreePath` locates the session). */
  binding?: WorkspaceBinding;
  /** Emit `task-changed` when the usage changed (default true). */
  publish?: boolean;
  /**
   * Keep a `ready` usage while its newest file changed less than this long
   * ago (ms): no re-parse until the files go quiet (the refresh tick).
   */
  quietMs?: number;
}

/** `computeUsage` outcome: nothing to report yet, the stored usage still holds, or a new one. */
type Computed =
  | { kind: "none" }
  | { kind: "unchanged" }
  | { kind: "usage"; usage: TaskUsage };

function sameUsage(a: TaskUsage | undefined, b: TaskUsage): boolean {
  if (!a) return false;
  const { computedAt: _a, ...left } = a;
  const { computedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

export class UsageRuntime {
  /**
   * One computation per task at a time (a trigger mid-run joins it);
   * `quiet` marks a run that may skip fresh files (`quietMs`).
   */
  private readonly inFlight = new Map<
    string,
    { run: Promise<TaskUsage | undefined>; quiet: boolean }
  >();
  /** The backfill drain in flight (single-flight, see `drain`). */
  private draining: Promise<void> | undefined;
  /** Ready tasks already queued once for a missing `lastActivityAt` (never retried this process). */
  private readonly activityChecked = new Set<string>();

  constructor(private readonly deps: UsageRuntimeDeps) {}

  /** Recompute and persist one task's usage; resolves with the usage as persisted. Never throws. */
  update(
    taskId: string,
    options: UpdateUsageOptions = {},
  ): Promise<TaskUsage | undefined> {
    const running = this.inFlight.get(taskId);
    const quiet = options.quietMs !== undefined;
    // A quiet-gated run (the tick) may skip a fresh change, so a caller
    // without the gate (a turn end) starts its own instead of joining it.
    if (running && !options.force && (quiet || !running.quiet)) {
      return running.run;
    }
    const run = this.runUpdate(taskId, options).finally(() => {
      if (this.inFlight.get(taskId)?.run === run) this.inFlight.delete(taskId);
    });
    this.inFlight.set(taskId, { run, quiet });
    return run;
  }

  /**
   * One refresh tick's re-check of tasks still being worked on: `pending`
   * ones (a session not written yet) and `ready` ones not Done (the agent
   * may have run turns since the last count, docs/costs.md follow-up 6).
   * Cheap: unchanged files are only stat'ed, and changed ones of a counted
   * task are re-parsed only once quiet (`TICK_QUIET_MS`). Awaited by the
   * refresh. Resolves with whether any task changed. Never-computed tasks
   * are the drain's (see `drain`).
   */
  async recheckOpen(
    tasks: readonly Task[],
    bindingFor: (taskId: string) => Promise<WorkspaceBinding | undefined>,
  ): Promise<boolean> {
    const open = tasks.filter(
      (task) =>
        task.usage?.status === "pending" ||
        (task.usage?.status === "ready" && task.state !== "done"),
    );
    return this.computeAll(open, bindingFor, { quietMs: TICK_QUIET_MS });
  }

  /**
   * The backfill drain (docs/costs.md "Backfill"): computes every task the
   * backfill still owes a first figure (never computed: Done tasks, so
   * missing sessions are marked `unavailable` exactly once, and tasks bound
   * to a session) plus, once per process, `ready` usage persisted before
   * `lastActivityAt` existed. Runs in batches of `DRAIN_BATCH` with
   * bounded concurrency, yielding to the event loop between batches and
   * calling `onBatch` (the board push) after a batch that changed a task.
   * Single-flight: a call while a drain runs returns the running one.
   * `unavailable` is never retried. Never rejects.
   */
  drain(
    listTasks: () => Promise<Task[]>,
    bindingFor: (taskId: string) => Promise<WorkspaceBinding | undefined>,
    onBatch: () => Promise<void>,
  ): Promise<void> {
    if (this.draining) return this.draining;
    const run = this.runDrain(listTasks, bindingFor, onBatch)
      .catch((error: unknown) => {
        this.deps.logger.warn("usage", "usage backfill failed", {
          outcome: "failed",
          error: logErrorMessage(error),
        });
      })
      .finally(() => {
        if (this.draining === run) this.draining = undefined;
      });
    this.draining = run;
    return run;
  }

  /** The running drain, or resolved when none runs. */
  idle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  private async runDrain(
    listTasks: () => Promise<Task[]>,
    bindingFor: (taskId: string) => Promise<WorkspaceBinding | undefined>,
    onBatch: () => Promise<void>,
  ): Promise<void> {
    const queue: Task[] = [];
    for (const task of await listTasks()) {
      if (awaitsUsageBackfill(task, await bindingFor(task.id))) {
        queue.push(task);
      } else if (
        task.usage?.status === "ready" &&
        !task.usage.lastActivityAt &&
        this.deps.sessions.stat &&
        !this.activityChecked.has(task.id)
      ) {
        this.activityChecked.add(task.id);
        queue.push(task);
      }
    }
    for (let start = 0; start < queue.length; start += DRAIN_BATCH) {
      const batch = queue.slice(start, start + DRAIN_BATCH);
      if (await this.computeAll(batch, bindingFor)) {
        await onBatch().catch(() => {});
      }
      await yieldToEventLoop();
    }
  }

  /** Recompute `tasks` (no per-task publish); resolves with whether any changed. */
  private async computeAll(
    tasks: readonly Task[],
    bindingFor: (taskId: string) => Promise<WorkspaceBinding | undefined>,
    options: Pick<UpdateUsageOptions, "quietMs"> = {},
  ): Promise<boolean> {
    let changed = false;
    await forEachConcurrently(tasks, BACKFILL_CONCURRENCY, async (task) => {
      const before = task.usage;
      const binding = await bindingFor(task.id);
      const after = await this.update(task.id, {
        ...options,
        publish: false,
        ...(binding ? { binding } : {}),
      });
      if (after && !sameUsage(before, after)) changed = true;
    });
    return changed;
  }

  private async runUpdate(
    taskId: string,
    options: UpdateUsageOptions,
  ): Promise<TaskUsage | undefined> {
    const task = await this.deps.tasks.getTask(taskId).catch(() => undefined);
    if (!task) return undefined;
    let computed: Computed;
    try {
      computed = await this.computeUsage(task, options);
    } catch (error) {
      this.deps.logger.warn("usage", `usage read failed for task ${taskId}`, {
        taskId,
        outcome: "failed",
        error: logErrorMessage(error),
      });
      return task.usage;
    }
    if (computed.kind !== "usage") return task.usage;
    const next = computed.usage;
    if (sameUsage(task.usage, next) && !options.force) return task.usage;
    const patched = await this.deps.tasks.patchTask(taskId, (current) => ({
      ...current,
      usage: next,
    }));
    if (!patched) return undefined;
    if (options.publish !== false) {
      await this.deps.publish(patched).catch(() => {});
    }
    return patched.usage;
  }

  private async computeUsage(
    task: Task,
    options: UpdateUsageOptions,
  ): Promise<Computed> {
    const adapter = await this.deps.adapterFor(task);
    if (!adapter) return { kind: "none" };
    const now = this.deps.clock.now().toISOString();
    if (adapter === "unsupported" || !adapter.readSessionUsage) {
      return {
        kind: "usage",
        usage: placeholderUsage("unavailable", now, "unsupported"),
      };
    }
    const binding =
      options.binding ??
      (await this.deps.bindingFor(task.id).catch(() => undefined));
    const paths = await this.sessionPaths(task, binding, adapter);
    const done = task.state === "done";
    if (paths.length === 0) {
      if (done) {
        return {
          kind: "usage",
          usage: placeholderUsage("unavailable", now, "missing-session"),
        };
      }
      return binding?.sessionId
        ? { kind: "usage", usage: placeholderUsage("pending", now) }
        : { kind: "none" };
    }

    // The change check also covers files the reader counts besides the
    // sessions (Claude Code's subagent transcripts): a subagent can run
    // for minutes while the main transcript stays quiet.
    const extra =
      adapter.extraUsageFiles && this.deps.sessions.stat
        ? (
            await Promise.all(
              paths.map((path) =>
                (adapter.extraUsageFiles?.(path) ?? Promise.resolve([])).catch(
                  (): string[] => [],
                ),
              ),
            )
          ).flat()
        : [];
    const stats = await Promise.all(
      [...paths, ...extra].map(async (sessionPath) => ({
        sessionPath,
        stat: this.deps.sessions.stat
          ? await this.deps.sessions.stat(sessionPath).catch(() => undefined)
          : undefined,
      })),
    );
    const fingerprint = this.deps.sessions.stat
      ? usageFingerprint(stats)
      : undefined;
    const lastActivityAt = lastActivityFromStats(stats);
    if (
      !options.force &&
      fingerprint !== undefined &&
      task.usage?.status === "ready" &&
      task.usage.fingerprint === fingerprint
    ) {
      // Unchanged files: no re-parse. Usage persisted before
      // `lastActivityAt` existed gains it from these stats.
      if (lastActivityAt && task.usage.lastActivityAt !== lastActivityAt) {
        return { kind: "usage", usage: { ...task.usage, lastActivityAt } };
      }
      return { kind: "unchanged" };
    }
    if (
      !options.force &&
      options.quietMs !== undefined &&
      task.usage?.status === "ready" &&
      lastActivityAt &&
      Date.parse(now) - Date.parse(lastActivityAt) < options.quietMs
    ) {
      // Still being written (an agent mid-turn): count it once it is quiet.
      return { kind: "unchanged" };
    }

    const read = await Promise.all(
      paths.map((path) =>
        (adapter.readSessionUsage?.(path) ?? Promise.resolve(undefined)).catch(
          (): SessionUsage | undefined => undefined,
        ),
      ),
    );
    const sessions = read.filter(
      (usage): usage is SessionUsage => usage !== undefined,
    );
    if (sessions.length === 0) {
      // A ready usage is never thrown away because its files went away
      // (Pi/Claude session cleanup): what was counted stays counted.
      if (task.usage?.status === "ready") return { kind: "unchanged" };
      return {
        kind: "usage",
        usage: done
          ? placeholderUsage("unavailable", now, "missing-session")
          : placeholderUsage("pending", now),
      };
    }
    const counted = new Set(sessions.map((session) => session.sessionPath));
    if (
      task.usage?.status === "ready" &&
      task.usage.sessions.some((session) => !counted.has(session.sessionPath))
    ) {
      // A previously counted session is gone: keep the fuller figure.
      return { kind: "unchanged" };
    }
    const usage = summarizeTaskUsage(sessions, {
      harness: adapter.id,
      computedAt: now,
    });
    return {
      kind: "usage",
      usage: {
        ...usage,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      },
    };
  }

  /**
   * The task's session files, oldest cycle first: the previous cycle's,
   * then the current one (recorded, else the bound id resolved where the
   * harness writes it), then any session counted before (a twice-reopened
   * task's earlier cycles), without duplicates.
   */
  private async sessionPaths(
    task: Task,
    binding: WorkspaceBinding | undefined,
    adapter: HarnessAdapter,
  ): Promise<string[]> {
    const paths: string[] = [];
    const add = (path: string | undefined) => {
      if (path && !paths.includes(path)) paths.push(path);
    };
    for (const session of task.usage?.sessions ?? []) add(session.sessionPath);
    add(binding?.previousSessionPath);
    if (binding?.sessionPath) add(binding.sessionPath);
    else if (binding?.sessionId) {
      add(await this.resolveSessionFile(task, binding, adapter));
    }
    return paths;
  }

  private async resolveSessionFile(
    task: Task,
    binding: WorkspaceBinding,
    adapter: HarnessAdapter,
  ): Promise<string | undefined> {
    const sessionId = binding.sessionId;
    const { findSessionFile } = this.deps.sessions;
    if (!sessionId || !adapter.expectedSessionFile || !findSessionFile) {
      return undefined;
    }
    const cwd =
      binding.worktreePath ?? task.cleanup?.worktreePath ?? task.folderPath;
    if (!cwd) return undefined;
    const expected = adapter.expectedSessionFile(cwd, sessionId);
    if (!expected) return undefined;
    return findSessionFile
      .call(this.deps.sessions, expected.dir, expected.fileSuffix)
      .catch(() => undefined);
  }
}
