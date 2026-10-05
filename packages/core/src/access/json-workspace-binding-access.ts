// Resource Access: workspace-binding storage (phase 2 seam — see
// contracts/model.ts WorkspaceBinding doc comment). Round-trips today;
// nothing creates bindings until git-worktree/session access exist.

import { dirname } from "node:path";
import type { WorkspaceBinding } from "../contracts/model.js";
import type { WorkspaceBindingAccess } from "../contracts/services.js";
import { readJson, writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";

interface BindingStateFile {
  version: 1;
  bindings: WorkspaceBinding[];
}

const emptyState = (): BindingStateFile => ({ version: 1, bindings: [] });

export class JsonWorkspaceBindingAccess implements WorkspaceBindingAccess {
  readonly statePath: string;
  readonly lockPath: string;

  constructor(
    statePath: string,
    lockPath: string = `${dirname(statePath)}/workspace-bindings.lock`,
  ) {
    this.statePath = statePath;
    this.lockPath = lockPath;
  }

  async listBindings(): Promise<WorkspaceBinding[]> {
    return structuredClone((await this.readValidated()).bindings);
  }

  async getBindingForTask(
    taskId: string,
  ): Promise<WorkspaceBinding | undefined> {
    return structuredClone(
      (await this.readValidated()).bindings.find(
        (item) => item.taskId === taskId,
      ),
    );
  }

  async attachBinding(binding: WorkspaceBinding): Promise<void> {
    await this.mutate((state) => {
      if (
        state.bindings.some(
          (item) => item.id === binding.id || item.taskId === binding.taskId,
        )
      ) {
        throw new Error(
          `Workspace binding already exists for task: ${binding.taskId}`,
        );
      }
      state.bindings.push(binding);
    });
  }

  async replaceBinding(binding: WorkspaceBinding): Promise<void> {
    await this.mutate((state) => {
      const index = state.bindings.findIndex((item) => item.id === binding.id);
      if (index < 0)
        throw new Error(`Workspace binding not found: ${binding.id}`);
      state.bindings[index] = binding;
    });
  }

  async removeBinding(taskId: string): Promise<void> {
    await this.mutate((state) => {
      state.bindings = state.bindings.filter((item) => item.taskId !== taskId);
    });
  }

  private async mutate(
    change: (state: BindingStateFile) => void,
  ): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const state = await this.readValidated();
      change(state);
      this.validate(state);
      await writeJsonAtomic(this.statePath, state);
    });
  }

  private async readValidated(): Promise<BindingStateFile> {
    const state = await readJson<unknown>(this.statePath, emptyState);
    this.validate(state);
    return state as BindingStateFile;
  }

  private validate(value: unknown): asserts value is BindingStateFile {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.bindings)
    ) {
      throw new Error(
        `Unsupported or corrupt workspace binding state at ${this.statePath}`,
      );
    }
    const ids = new Set<string>();
    for (const item of value.bindings) {
      if (!validBinding(item) || ids.has(item.id))
        throw new Error(
          `Unsupported or corrupt workspace binding state at ${this.statePath}`,
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

function validBinding(value: unknown): value is WorkspaceBinding {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.taskId) &&
    isOptionalString(value.worktreePath) &&
    isOptionalString(value.branch) &&
    isOptionalString(value.sessionPath) &&
    typeof value.detached === "boolean" &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}
