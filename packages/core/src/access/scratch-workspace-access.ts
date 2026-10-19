// Resource Access: the plain-directory workspace for a `launchTask`
// `{ none: true }` (repository-less, `temp_task`) task. No git here at all
// -- that is the point: a scratch task's binding carries `scratch: true` so
// the manager never routes it through GitWorktreeAccess.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ScratchWorkspaceAccess } from "../contracts/services.js";

export class LocalScratchWorkspaceAccess implements ScratchWorkspaceAccess {
  constructor(private readonly scratchRoot: string) {}

  async ensureScratchDirectory(taskId: string): Promise<string> {
    // Task ids are UUIDs, but never trust a path component.
    const path = join(
      this.scratchRoot,
      taskId.replaceAll(/[^A-Za-z0-9._-]/g, "_"),
    );
    await mkdir(path, { recursive: true });
    return path;
  }
}
