// Manager helper: per-task token usage (docs/costs.md "Adapter parses, core
// persists"). Finds a task's session files (binding `sessionPath` +
// `previousSessionPath`, the bound session id resolved through the
// adapter's `expectedSessionFile`, and sessions already counted), has the
// task's harness adapter read them, sums them with the pure usage engine
// and persists `task.usage`. Triggers live in CoreManager (session
// recorded, agent finished/outcome, Done, the refresh backfill,
// `refreshTaskUsage`). Never throws into those commands: a failure is
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
  placeholderUsage,
  summarizeTaskUsage,
  usageFingerprint,
} from "../engines/usage.js";
import { forEachConcurrently } from "../utilities/concurrency.js";
import { logErrorMessage } from "../utilities/timed.js";

/** Tasks without usage computed per refresh tick (pending ones are always rechecked; they are cheap). */
const BACKFILL_BATCH = 16;
const BACKFILL_CONCURRENCY = 4;

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
  /** One computation per task at a time (a trigger mid-run joins it). */
  private readonly inFlight = new Map<string, Promise<TaskUsage | undefined>>();

  constructor(private readonly deps: UsageRuntimeDeps) {}

  /** Recompute and persist one task's usage; resolves with the usage as persisted. Never throws. */
  update(
    taskId: string,
    options: UpdateUsageOptions = {},
  ): Promise<TaskUsage | undefined> {
    const running = this.inFlight.get(taskId);
    if (running && !options.force) return running;
    const run = this.runUpdate(taskId, options).finally(() => {
      if (this.inFlight.get(taskId) === run) this.inFlight.delete(taskId);
    });
    this.inFlight.set(taskId, run);
    return run;
  }

  /**
   * One refresh tick's backfill: tasks whose usage was never computed (a
   * batch per tick, Done tasks included so missing sessions are marked
   * `unavailable` exactly once) and tasks still `pending`. `unavailable`
   * is never retried here. Resolves with whether any task changed.
   */
  async backfill(
    tasks: readonly Task[],
    bindingFor: (taskId: string) => Promise<WorkspaceBinding | undefined>,
  ): Promise<boolean> {
    const pending: Task[] = [];
    const fresh: Task[] = [];
    for (const task of tasks) {
      if (task.usage?.status === "pending") pending.push(task);
      else if (!task.usage) {
        if (task.state === "done") fresh.push(task);
        else {
          const binding = await bindingFor(task.id);
          if (
            binding?.sessionId ||
            binding?.sessionPath ||
            binding?.previousSessionPath
          ) {
            fresh.push(task);
          }
        }
      }
    }
    const batch = [...pending, ...fresh.slice(0, BACKFILL_BATCH)];
    let changed = false;
    await forEachConcurrently(batch, BACKFILL_CONCURRENCY, async (task) => {
      const before = task.usage;
      const binding = await bindingFor(task.id);
      const after = await this.update(task.id, {
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

    const stats = await Promise.all(
      paths.map(async (sessionPath) => ({
        sessionPath,
        stat: this.deps.sessions.stat
          ? await this.deps.sessions.stat(sessionPath).catch(() => undefined)
          : undefined,
      })),
    );
    const fingerprint = this.deps.sessions.stat
      ? usageFingerprint(stats)
      : undefined;
    if (
      !options.force &&
      fingerprint !== undefined &&
      task.usage?.status === "ready" &&
      task.usage.fingerprint === fingerprint
    ) {
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
      usage: fingerprint ? { ...usage, fingerprint } : usage,
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
