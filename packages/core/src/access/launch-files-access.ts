// Resource Access: the per-task files a launch leaves under the state dir
// for the agent to read (LaunchSpec.promptFile: `prompts/<taskId>.md`;
// Cursor's `cursor-plugins/<taskId>/`). The launcher writes them before
// each spawn; core removes them once the task is done or deleted (a
// reopened task's next launch writes them again).

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchFilesAccess } from "../contracts/services.js";
import type { StatePaths } from "../utilities/state-paths.js";

export class LocalLaunchFilesAccess implements LaunchFilesAccess {
  constructor(
    private readonly paths: Pick<StatePaths, "promptsDir" | "cursorPluginsDir">,
  ) {}

  async removeTaskLaunchFiles(taskId: string): Promise<void> {
    // Task ids are UUIDs, but never trust a path component (same rule as
    // promptFilePath / cursorPluginDir).
    const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    await Promise.all([
      rm(join(this.paths.promptsDir, `${safe}.md`), { force: true }),
      rm(join(this.paths.cursorPluginsDir, safe), {
        recursive: true,
        force: true,
      }),
    ]);
  }
}
