// Resource Access: owns the task list's on-disk storage. All filesystem I/O
// for tasks lives here — Managers and Engines never touch `tasksFile`
// directly (hard rule, see /AGENTS.md). Ported/simplified from pi-home's
// JsonWorkspaceBindingAccess: one array of unified `Task` records instead of
// separate workspaceBindings/temporaryWorkspaces/completionCleanups (those
// return in later phases alongside Beads/GitHub access).

import { dirname } from "node:path";
import type { Task } from "../contracts/model.js";
import type { TaskStateAccess } from "../contracts/services.js";
import { writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";
import { JsonFileCache } from "../utilities/json-file-cache.js";

interface TaskStateFile {
  version: 1;
  tasks: Task[];
}

const emptyState = (): TaskStateFile => ({ version: 1, tasks: [] });

export class JsonTaskStateAccess implements TaskStateAccess {
  readonly statePath: string;
  readonly lockPath: string;
  /** Parse cache: unchanged files skip read+parse+validate (see utilities/json-file-cache.ts). */
  private readonly cache: JsonFileCache<TaskStateFile>;

  constructor(
    statePath: string,
    lockPath: string = `${dirname(statePath)}/tasks.lock`,
  ) {
    this.statePath = statePath;
    this.lockPath = lockPath;
    this.cache = new JsonFileCache<TaskStateFile>(
      statePath,
      emptyState,
      (value) => this.validate(value),
    );
  }

  async listTasks(): Promise<Task[]> {
    return structuredClone((await this.readShared()).tasks);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return structuredClone(
      (await this.readShared()).tasks.find((task) => task.id === id),
    );
  }

  async createTask(task: Task): Promise<void> {
    await this.mutate((state) => {
      if (state.tasks.some((item) => item.id === task.id))
        throw new Error(`Task already exists: ${task.id}`);
      state.tasks.push(task);
    });
  }

  async replaceTask(task: Task): Promise<void> {
    await this.mutate((state) => {
      const index = state.tasks.findIndex((item) => item.id === task.id);
      if (index < 0) throw new Error(`Task not found: ${task.id}`);
      state.tasks[index] = task;
    });
  }

  async patchTask(
    id: string,
    patch: (current: Task) => Task | undefined,
  ): Promise<Task | undefined> {
    return withFileLock(this.lockPath, async () => {
      // Read the shared parse and clone only the one task: most patches
      // (refresh's per-task observations) change nothing and never write.
      const shared = await this.readShared();
      const index = shared.tasks.findIndex((item) => item.id === id);
      const current = shared.tasks[index];
      if (index < 0 || !current) return undefined;
      const next = patch(structuredClone(current));
      // Nothing changed: leave the file unwritten.
      if (!next) return structuredClone(current);
      if (next.id !== id) {
        throw new Error(`patchTask cannot change a task id: ${id}`);
      }
      const state: TaskStateFile = { ...shared, tasks: [...shared.tasks] };
      state.tasks[index] = next;
      this.validate(state);
      await this.write(state);
      return structuredClone(next);
    });
  }

  async removeTask(id: string): Promise<void> {
    await this.mutate((state) => {
      state.tasks = state.tasks.filter((item) => item.id !== id);
    });
  }

  async claimQueuedLaunches(limit: number, startedAt: string): Promise<Task[]> {
    if (limit <= 0) return [];
    return withFileLock(this.lockPath, async () => {
      const state = await this.readValidated();
      const queued = state.tasks
        .filter(
          (task) => task.state === "dev" && task.launch?.status === "queued",
        )
        .sort((a, b) =>
          (a.launch?.requestedAt ?? "").localeCompare(
            b.launch?.requestedAt ?? "",
          ),
        )
        .slice(0, limit);
      const claimed: Task[] = [];
      for (const task of queued) {
        const index = state.tasks.findIndex((item) => item.id === task.id);
        if (index < 0 || !task.launch) continue;
        const next: Task = {
          ...task,
          launch: { ...task.launch, status: "started", startedAt },
          updatedAt: startedAt,
        };
        delete next.launch?.interruptedAt;
        state.tasks[index] = next;
        claimed.push(structuredClone(next));
      }
      if (claimed.length > 0) {
        this.validate(state);
        await this.write(state);
      }
      return claimed;
    });
  }

  private async mutate(change: (state: TaskStateFile) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const state = await this.readValidated();
      change(state);
      this.validate(state);
      await this.write(state);
    });
  }

  /** The cached parse, shared: read-only. Clone anything handed out. */
  private readShared(): Promise<TaskStateFile> {
    return this.cache.read();
  }

  /** A private, mutable copy of the current state (for mutations). */
  private async readValidated(): Promise<TaskStateFile> {
    return structuredClone(await this.readShared());
  }

  private async write(state: TaskStateFile): Promise<void> {
    this.cache.invalidate();
    try {
      await writeJsonAtomic(this.statePath, state);
    } finally {
      this.cache.invalidate();
    }
  }

  private validate(value: unknown): asserts value is TaskStateFile {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.tasks)
    ) {
      throw new Error(`Unsupported or corrupt task state at ${this.statePath}`);
    }
    const ids = new Set<string>();
    for (const item of value.tasks) {
      if (!validTask(item) || ids.has(item.id))
        throw new Error(
          `Unsupported or corrupt task state at ${this.statePath}`,
        );
      ids.add(item.id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isValidPr(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  // Lenient beyond number/state: refresh() may enrich this record with
  // review/merge fields over time, and corrupt-state detection only needs
  // to catch structurally broken records, not reject forward-compatible ones.
  return (
    typeof value.number === "number" &&
    (["draft", "open", "merged", "closed"] as const).includes(
      value.state as never,
    )
  );
}

function isValidAwaiting(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "review") return true;
  if (value.kind === "slack") return isOptionalString(value.permalink);
  if (value.kind === "deploy") {
    return isString(value.stageId) && isString(value.stageLabel);
  }
  return false;
}

function isValidLaunch(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    (["queued", "started", "interrupted"] as const).includes(
      value.status as never,
    ) &&
    isString(value.requestedAt) &&
    isOptionalString(value.startedAt) &&
    isOptionalString(value.interruptedAt) &&
    isOptionalString(value.model)
  );
}

function validTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    (value.kind === "task" || value.kind === "temp_task") &&
    ["backlog", "dev", "awaiting", "done"].includes(value.state as string) &&
    isString(value.title) &&
    typeof value.initialPrompt === "string" &&
    isOptionalString(value.initialPromptDeliveredAt) &&
    isOptionalString(value.repositoryId) &&
    isOptionalString(value.branch) &&
    isOptionalString(value.targetBranch) &&
    isOptionalString(value.issueRef) &&
    isOptionalString(value.pihomeIssueId) &&
    isValidPr(value.pr) &&
    isValidAwaiting(value.awaiting) &&
    isOptionalString(value.parentTaskId) &&
    isOptionalString(value.launchedFromTaskId) &&
    isValidLaunch(value.launch) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isString(value.stateChangedAt) &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.archivedAt) &&
    isOptionalString(value.lastError)
  );
}
