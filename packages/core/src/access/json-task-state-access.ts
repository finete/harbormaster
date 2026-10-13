// Resource Access: owns the task list's on-disk storage. All filesystem I/O
// for tasks lives here — Managers and Engines never touch `tasksFile`
// directly (hard rule, see /AGENTS.md). Ported/simplified from pi-home's
// JsonWorkspaceBindingAccess: one array of unified `Task` records instead of
// separate workspaceBindings/temporaryWorkspaces/completionCleanups (those
// return in later phases alongside Beads/GitHub access).

import { dirname } from "node:path";
import type { Task } from "../contracts/model.js";
import type { TaskStateAccess } from "../contracts/services.js";
import { readJson, writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";

interface TaskStateFile {
  version: 1;
  tasks: Task[];
}

const emptyState = (): TaskStateFile => ({ version: 1, tasks: [] });

export class JsonTaskStateAccess implements TaskStateAccess {
  readonly statePath: string;
  readonly lockPath: string;

  constructor(
    statePath: string,
    lockPath: string = `${dirname(statePath)}/tasks.lock`,
  ) {
    this.statePath = statePath;
    this.lockPath = lockPath;
  }

  async listTasks(): Promise<Task[]> {
    return structuredClone((await this.readValidated()).tasks);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return structuredClone(
      (await this.readValidated()).tasks.find((task) => task.id === id),
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

  async removeTask(id: string): Promise<void> {
    await this.mutate((state) => {
      state.tasks = state.tasks.filter((item) => item.id !== id);
    });
  }

  private async mutate(change: (state: TaskStateFile) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const state = await this.readValidated();
      change(state);
      this.validate(state);
      await writeJsonAtomic(this.statePath, state);
    });
  }

  private async readValidated(): Promise<TaskStateFile> {
    const state = await readJson<unknown>(this.statePath, emptyState);
    this.validate(state);
    return state as TaskStateFile;
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
    isValidPr(value.pr) &&
    isValidAwaiting(value.awaiting) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isString(value.stateChangedAt) &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.archivedAt) &&
    isOptionalString(value.lastError)
  );
}
