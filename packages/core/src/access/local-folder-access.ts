// Resource Access: user folders registered outside `codeRoot` (the
// composer's "Open folder…", see /docs/new-task-composer.md "Where"), plus
// the per-task copies of images pasted into a prompt. The folder registry is
// core state in `<stateDir>/locations.json`, not the user-edited config file,
// so registering a folder never rewrites config.json.

import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  FolderAccess,
  TaskAttachmentAccess,
} from "../contracts/services.js";
import { readJson, writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";

interface LocationsFile {
  folders: string[];
}

export class JsonFolderAccess implements FolderAccess {
  constructor(
    private readonly path: string,
    private readonly lockPath: string = `${path}.lock`,
  ) {}

  async listRegisteredFolders(): Promise<string[]> {
    const file = await readJson<LocationsFile>(this.path, () => ({
      folders: [],
    }));
    return Array.isArray(file.folders)
      ? file.folders.filter((entry) => typeof entry === "string")
      : [];
  }

  async registerFolder(path: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch {
      throw new Error(`Folder not found: ${path}`);
    }
    if (!(await this.isDirectory(resolved))) {
      throw new Error(`Not a folder: ${path}`);
    }
    await withFileLock(this.lockPath, async () => {
      const folders = await this.listRegisteredFolders();
      if (folders.includes(resolved)) return;
      await writeJsonAtomic(this.path, {
        folders: [...folders, resolved],
      } satisfies LocationsFile);
    });
    return resolved;
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}

export class LocalTaskAttachmentAccess implements TaskAttachmentAccess {
  constructor(private readonly root: string) {}

  async copyIntoTask(
    taskId: string,
    paths: string[],
  ): Promise<Map<string, string>> {
    const copies = new Map<string, string>();
    if (paths.length === 0) return copies;
    // Task ids are UUIDs, but never trust a path component.
    const dir = join(this.root, taskId.replaceAll(/[^A-Za-z0-9._-]/g, "_"));
    await mkdir(dir, { recursive: true });
    let index = 0;
    for (const source of new Set(paths)) {
      index += 1;
      const name = basename(source).replaceAll(/[^A-Za-z0-9._-]/g, "_");
      const target = join(
        dir,
        name || `attachment-${index}${extname(source) || ".png"}`,
      );
      try {
        await copyFile(source, target);
        copies.set(source, target);
      } catch {
        // A file that vanished or cannot be read keeps its original path.
      }
    }
    return copies;
  }
}
