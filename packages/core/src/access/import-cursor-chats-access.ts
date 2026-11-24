// Resource Access: Cursor's chat store (docs/import.md F5). One reader of
// `<CURSOR_CONFIG_DIR | $XDG_CONFIG_HOME/cursor | ~/.cursor>/chats/<md5(cwd)>/<chatId>/`:
// `meta.json` (`cwd`, `title`, `createdAtMs`, `updatedAtMs`) and
// `prompt_history.json` (the typed prompts). Chats from before `meta.json`
// existed are skipped: nothing in them names the folder reliably.

import { readFile } from "node:fs/promises";
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
  listDir,
  readerEnv,
  readerHome,
  statOrUndefined,
} from "./import-reader-common.js";

export interface CursorChatsReaderOptions extends ImportReaderOptions {
  /** Cursor's config dir (default `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `<home>/.cursor`). */
  configDir?: string;
}

export class CursorChatsReader implements ImportSourceReader {
  readonly id = "cursor" as const;
  readonly label = "Cursor";
  private readonly cache = new FileParseCache<
    ImportSessionRecord | undefined
  >();

  constructor(private readonly options: CursorChatsReaderOptions = {}) {}

  private configDir(): string {
    const env = readerEnv(this.options);
    if (this.options.configDir) return this.options.configDir;
    if (env.CURSOR_CONFIG_DIR) return env.CURSOR_CONFIG_DIR;
    if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "cursor");
    return join(readerHome(this.options), ".cursor");
  }

  async read({ since }: ImportReadOptions): Promise<ImportSourceReading> {
    const root = join(this.configDir(), "chats");
    const chats: { dir: string; mtimeMs: number; size: number; id: string }[] =
      [];
    for (const hash of await listDir(root)) {
      if (!hash.isDirectory) continue;
      for (const chat of await listDir(join(root, hash.name))) {
        if (!chat.isDirectory) continue;
        const dir = join(root, hash.name, chat.name);
        const info = await statOrUndefined(join(dir, "meta.json"));
        if (info && info.mtimeMs >= since.getTime()) {
          chats.push({ dir, ...info, id: chat.name });
        }
      }
    }
    const sessions: ImportSessionRecord[] = [];
    await forEachConcurrently(chats, 8, async (chat) => {
      const record = await this.cache.get(chat.dir, chat, () =>
        parseChat(chat.dir, chat.id, chat.mtimeMs),
      );
      if (record && Date.parse(record.lastActiveAt) >= since.getTime()) {
        sessions.push(record);
      }
    });
    return { sessions, orchestrations: [] };
  }
}

async function parseChat(
  dir: string,
  chatId: string,
  mtimeMs: number,
): Promise<ImportSessionRecord | undefined> {
  let meta: {
    cwd?: unknown;
    title?: unknown;
    createdAtMs?: unknown;
    updatedAtMs?: unknown;
  };
  try {
    meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof meta.cwd !== "string" || !meta.cwd) return undefined;
  let userPrompts = 0;
  try {
    const history = JSON.parse(
      await readFile(join(dir, "prompt_history.json"), "utf8"),
    );
    if (Array.isArray(history)) userPrompts = history.length;
  } catch {}
  const at = (ms: unknown) =>
    typeof ms === "number" && Number.isFinite(ms)
      ? new Date(ms).toISOString()
      : undefined;
  const title = typeof meta.title === "string" ? meta.title.trim() : "";
  const startedAt = at(meta.createdAtMs);
  return {
    harness: "cursor",
    sessionId: chatId,
    // The chat directory: Cursor keeps its transcript store inside it.
    sessionPath: dir,
    cwd: meta.cwd,
    ...(startedAt ? { startedAt } : {}),
    lastActiveAt: at(meta.updatedAtMs) ?? new Date(mtimeMs).toISOString(),
    userPrompts,
    ...(title ? { title } : {}),
  };
}
