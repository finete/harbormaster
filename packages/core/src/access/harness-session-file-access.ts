// Resource Access: harness session files on disk. Deliberately tiny — core
// never reads, writes, or locates Pi's JSONL transcripts itself (that is the
// harness's format and directory layout, see /AGENTS.md "Agent harnesses
// are adapters"); it only checks that a session file the harness reported
// (`CoreCommands.recordTaskSession`) is still there before asking the
// harness to resume or fork it. pi-home's PiSessionAccess.exists, ported.

import { access } from "node:fs/promises";
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
}
