// Resource Access: read-only reader for pi-home's `state.json` (v4
// workspace-binding state). Mirrors the read path of pi-home's
// `JsonWorkspaceBindingAccess` (src/access/json-workspace-binding-access.ts)
// but never writes: this module's one write anywhere in pi-home's home is
// the automation flag in config.json (`PiHomeConfigAccess`), not this file.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PiHomeState,
  PiHomeTemporaryWorkspace,
  PiHomeWorkspaceBinding,
} from "../contracts.js";

export class PiHomeStateFileAccess {
  readonly statePath: string;

  constructor(piHomeDir: string) {
    this.statePath = join(piHomeDir, "state.json");
  }

  async read(): Promise<PiHomeState> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read pi-home state at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(raw)) {
      throw new Error(`Unexpected pi-home state shape at ${this.statePath}`);
    }
    const workspaceBindings = Array.isArray(raw.workspaceBindings)
      ? raw.workspaceBindings.filter(isWorkspaceBinding)
      : [];
    const temporaryWorkspaces = Array.isArray(raw.temporaryWorkspaces)
      ? raw.temporaryWorkspaces.filter(isTemporaryWorkspace)
      : [];
    return {
      version: typeof raw.version === "number" ? raw.version : 0,
      workspaceBindings,
      temporaryWorkspaces,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRepositoryRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.preferredCheckout) &&
    isString(value.defaultBranch)
  );
}

function isWorkspaceBinding(value: unknown): value is PiHomeWorkspaceBinding {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.issueId) &&
    isRepositoryRef(value.repository) &&
    isString(value.sessionPath) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

function isTemporaryWorkspace(
  value: unknown,
): value is PiHomeTemporaryWorkspace {
  return (
    isRecord(value) &&
    value.kind === "temp_task" &&
    isString(value.id) &&
    ["dev", "awaiting", "done"].includes(value.state as string) &&
    isString(value.title) &&
    typeof value.initialPrompt === "string" &&
    isString(value.sessionPath) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isString(value.stateChangedAt)
  );
}
