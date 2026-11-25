// Resource Access: Codex's session store (docs/import.md F4). One reader of
// `<CODEX_HOME | ~/.codex>/sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl`.
// Line 1 is `session_meta` (id, cwd, source, git branch); thread names come
// from `session_index.jsonl` (the last line per id wins). Non-interactive
// sessions (`source: "exec"`, sub-agent threads) are agent-internal and are
// skipped (decision I17).
//
// Human prompts: recorded with codex 0.170.0, every typed prompt is an
// `event_msg` / `item_completed` whose item is a `UserMessage`; the injected
// AGENTS.md / environment context never is (it only appears as user-role
// `response_item`s, which are NOT counted), and no `user_message` events are
// written. A rollout from a Codex that predates this counts 0 prompts and so
// lands behind "show hidden" (nothing recorded to verify an older shape).

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

export interface CodexSessionsReaderOptions extends ImportReaderOptions {
  /** Codex's home (default `$CODEX_HOME`, else `<home>/.codex`). */
  codexHome?: string;
}

const DAY = 86_400_000;

export class CodexSessionsReader implements ImportSourceReader {
  readonly id = "codex" as const;
  readonly label = "Codex";
  private readonly cache = new FileParseCache<ParsedRollout | undefined>();
  private readonly indexCache = new FileParseCache<Map<string, string>>();

  constructor(private readonly options: CodexSessionsReaderOptions = {}) {}

  private codexHome(): string {
    const env = readerEnv(this.options);
    return (
      this.options.codexHome ??
      env.CODEX_HOME ??
      join(readerHome(this.options), ".codex")
    );
  }

  async read({ since }: ImportReadOptions): Promise<ImportSourceReading> {
    const home = this.codexHome();
    const root = join(home, "sessions");
    const files: { path: string; mtimeMs: number; size: number }[] = [];
    // YYYY/MM/DD directories: skip days that end before `since` (by name).
    const floor = since.getTime() - 2 * DAY;
    for (const year of await listDir(root)) {
      if (!year.isDirectory || !/^\d{4}$/.test(year.name)) continue;
      for (const month of await listDir(join(root, year.name))) {
        if (!month.isDirectory || !/^\d\d$/.test(month.name)) continue;
        for (const day of await listDir(join(root, year.name, month.name))) {
          if (!day.isDirectory || !/^\d\d$/.test(day.name)) continue;
          const dayStart = Date.UTC(
            Number(year.name),
            Number(month.name) - 1,
            Number(day.name),
          );
          if (dayStart + DAY < floor) continue;
          const dir = join(root, year.name, month.name, day.name);
          for (const entry of await listDir(dir)) {
            if (
              !entry.isFile ||
              !entry.name.startsWith("rollout-") ||
              !entry.name.endsWith(".jsonl")
            ) {
              continue;
            }
            const path = join(dir, entry.name);
            const info = await statOrUndefined(path);
            if (info && info.mtimeMs >= since.getTime()) {
              files.push({ path, ...info });
            }
          }
        }
      }
    }
    const names = await this.threadNames(home);
    const sessions: ImportSessionRecord[] = [];
    await forEachConcurrently(files, 8, async (file) => {
      const parsed = await this.cache.get(file.path, file, () =>
        parseRollout(file.path, file),
      );
      if (!parsed || Date.parse(parsed.lastActiveAt) < since.getTime()) return;
      const title = names.get(parsed.sessionId);
      sessions.push({
        ...parsed,
        ...(title ? { title } : {}),
      });
    });
    return { sessions, orchestrations: [] };
  }

  /** `session_index.jsonl`: thread name per session id, the last line per id wins. */
  private async threadNames(home: string): Promise<Map<string, string>> {
    const path = join(home, "session_index.jsonl");
    const info = await statOrUndefined(path);
    if (!info) return new Map();
    return this.indexCache.get(path, info, async () => {
      const names = new Map<string, string>();
      await streamLines(path, (line) => {
        try {
          const entry = JSON.parse(line);
          if (
            typeof entry?.id === "string" &&
            typeof entry.thread_name === "string" &&
            entry.thread_name.trim()
          ) {
            names.set(entry.id, entry.thread_name.trim());
          }
        } catch {}
        return true;
      });
      return names;
    });
  }
}

type ParsedRollout = ImportSessionRecord;

async function parseRollout(
  path: string,
  info: { mtimeMs: number; size: number },
): Promise<ParsedRollout | undefined> {
  let meta:
    | {
        id?: string;
        cwd?: string;
        timestamp?: string;
        source?: unknown;
        thread_source?: unknown;
        git?: { branch?: string };
      }
    | undefined;
  let first = true;
  let userPrompts = 0;
  try {
    await streamLines(path, (line) => {
      if (first) {
        first = false;
        try {
          const entry = JSON.parse(line);
          if (entry?.type !== "session_meta") return false;
          meta = entry.payload;
        } catch {
          return false;
        }
        return true;
      }
      if (line.includes('"UserMessage"') && line.includes('"item_completed"')) {
        try {
          const payload = JSON.parse(line)?.payload;
          if (
            payload?.type === "item_completed" &&
            payload.item?.type === "UserMessage"
          ) {
            userPrompts += 1;
          }
        } catch {}
      }
      return true;
    });
  } catch {
    return undefined;
  }
  const head = meta as NonNullable<typeof meta> | undefined;
  if (!head?.id || !head.cwd) return undefined;
  // Agent-internal: non-interactive `exec`, sub-agent threads (I17).
  if (head.source === "exec") return undefined;
  if (head.source !== undefined && typeof head.source === "object")
    return undefined;
  if (typeof head.thread_source === "string" && head.thread_source !== "user") {
    return undefined;
  }
  const lastActiveAt =
    isoOr(await lastTimestamp(path, info.size)) ??
    new Date(info.mtimeMs).toISOString();
  const startedAt = isoOr(head.timestamp);
  const branch = head.git?.branch;
  return {
    harness: "codex",
    sessionId: head.id,
    sessionPath: path,
    cwd: head.cwd,
    ...(startedAt ? { startedAt } : {}),
    lastActiveAt,
    userPrompts,
    ...(branch ? { branch } : {}),
  };
}
