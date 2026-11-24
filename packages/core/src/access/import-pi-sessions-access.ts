// Resource Access: Pi's session store (docs/import.md F1). One reader of
// `<PI_CODING_AGENT_DIR | ~/.pi/agent>/sessions/--<cwd slug>--/<ISO>_<id>.jsonl`.
// Only the files directly in a slug directory are sessions: pi-subagents'
// child sessions live in nested directories (decision I17) and are never
// read. The folder comes from the header's `cwd`, never from the slug.

import { join } from "node:path";
import type {
  ImportReadOptions,
  ImportSessionRecord,
  ImportSourceReader,
  ImportSourceReading,
} from "../contracts/import.js";
import { forEachConcurrently } from "../utilities/concurrency.js";
import {
  FileParseCache,
  type ImportReaderOptions,
  isoOr,
  lastTimestamp,
  listDir,
  readerEnv,
  readerHome,
  statOrUndefined,
  streamLines,
} from "./import-reader-common.js";

export interface PiSessionsReaderOptions extends ImportReaderOptions {
  /** Pi's agent dir (default `$PI_CODING_AGENT_DIR`, else `<home>/.pi/agent`). */
  agentDir?: string;
}

export class PiSessionsReader implements ImportSourceReader {
  readonly id = "pi" as const;
  readonly label = "Pi";
  private readonly cache = new FileParseCache<
    ImportSessionRecord | undefined
  >();

  constructor(private readonly options: PiSessionsReaderOptions = {}) {}

  private sessionsDir(): string {
    const env = readerEnv(this.options);
    const agentDir =
      this.options.agentDir ??
      env.PI_CODING_AGENT_DIR ??
      join(readerHome(this.options), ".pi", "agent");
    return join(agentDir, "sessions");
  }

  async read({ since }: ImportReadOptions): Promise<ImportSourceReading> {
    const root = this.sessionsDir();
    const files: { path: string; mtimeMs: number; size: number }[] = [];
    for (const slug of await listDir(root)) {
      if (!slug.isDirectory) continue;
      for (const entry of await listDir(join(root, slug.name))) {
        if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
        const path = join(root, slug.name, entry.name);
        const info = await statOrUndefined(path);
        if (info && info.mtimeMs >= since.getTime())
          files.push({ path, ...info });
      }
    }
    const sessions: ImportSessionRecord[] = [];
    await forEachConcurrently(files, 8, async (file) => {
      const record = await this.cache.get(file.path, file, () =>
        parsePiSession(file.path, file),
      );
      if (record && Date.parse(record.lastActiveAt) >= since.getTime()) {
        sessions.push(record);
      }
    });
    return { sessions, orchestrations: [] };
  }
}

async function parsePiSession(
  path: string,
  info: { mtimeMs: number; size: number },
): Promise<ImportSessionRecord | undefined> {
  let header: { id?: string; cwd?: string; timestamp?: string } | undefined;
  let title: string | undefined;
  let userPrompts = 0;
  let first = true;
  try {
    await streamLines(path, (line) => {
      if (first) {
        first = false;
        try {
          const entry = JSON.parse(line);
          if (entry?.type !== "session") return false;
          header = entry;
        } catch {
          return false;
        }
        return true;
      }
      // Substring pre-filter: only user messages and name changes matter.
      if (line.includes('"type":"session_info"')) {
        try {
          const name = JSON.parse(line)?.name;
          if (typeof name === "string") title = name.trim() || undefined;
        } catch {}
      } else if (
        line.includes('"role":"user"') &&
        line.includes('"type":"message"')
      ) {
        try {
          if (JSON.parse(line)?.message?.role === "user") userPrompts += 1;
        } catch {}
      }
      return true;
    });
  } catch {
    return undefined;
  }
  const head = header as
    | { id?: string; cwd?: string; timestamp?: string }
    | undefined;
  if (!head?.id || !head.cwd) return undefined;
  const lastActiveAt =
    (await lastTimestamp(path, info.size)) ??
    new Date(info.mtimeMs).toISOString();
  const startedAt = isoOr(head.timestamp);
  return {
    harness: "pi",
    sessionId: head.id,
    sessionPath: path,
    cwd: head.cwd,
    ...(startedAt ? { startedAt } : {}),
    lastActiveAt: isoOr(lastActiveAt) ?? new Date(info.mtimeMs).toISOString(),
    userPrompts,
    ...(title ? { title } : {}),
  };
}
