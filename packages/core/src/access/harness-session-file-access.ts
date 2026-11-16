// Resource Access: harness session files on disk. Deliberately tiny — core
// never reads, writes, or locates Pi's JSONL transcripts itself (that is the
// harness's format and directory layout, see /AGENTS.md "Agent harnesses
// are adapters"); it only checks that a session file the harness reported
// (`CoreCommands.recordTaskSession`) is still there before asking the
// harness to resume or fork it. pi-home's PiSessionAccess.exists, ported.
// `findSessionFile` lists one directory the harness adapter named
// (`HarnessAdapter.expectedSessionFile`) for the post-launch confirmation
// and for locating a bound session's file for usage; `stat` is the usage
// change detector (docs/costs.md: unchanged sessions are never re-parsed).

import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionFileAccess } from "../contracts/services.js";

export class LocalSessionFileAccess implements SessionFileAccess {
  async exists(sessionPath: string): Promise<boolean> {
    if (!sessionPath) return false;
    try {
      await access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(
    sessionPath: string,
  ): Promise<{ size: number; mtimeMs: number } | undefined> {
    if (!sessionPath) return undefined;
    try {
      const info = await stat(sessionPath);
      return info.isFile()
        ? { size: info.size, mtimeMs: info.mtimeMs }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async findSessionFile(
    dir: string,
    fileSuffix: string,
  ): Promise<string | undefined> {
    if (!dir || !fileSuffix) return undefined;
    try {
      const name = (await readdir(dir)).find((entry) =>
        entry.endsWith(fileSuffix),
      );
      return name ? join(dir, name) : undefined;
    } catch {
      return undefined;
    }
  }
}
