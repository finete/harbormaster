// Resource Access: Claude Code's session store (docs/import.md F2). One
// reader of `<CLAUDE_CONFIG_DIR | ~/.claude>/projects/<slug>/<sessionId>.jsonl`.
// The slug is lossy (every `/` and `.` becomes `-`), so the folder is the
// `cwd` recorded in the entries. Subagent transcripts live under
// `<sessionId>/subagents/` (never read) and a file whose entries are all
// sidechains is not a session of its own (decision I17).

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

export interface ClaudeSessionsReaderOptions extends ImportReaderOptions {
  /** Claude's config dir (default `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`). */
  configDir?: string;
}

/** Claude wraps slash commands and local command output in these tags: not something a human typed. */
const NOT_TYPED =
  /^\s*<(command-name|command-message|command-args|local-command)/;

export class ClaudeSessionsReader implements ImportSourceReader {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";
  private readonly cache = new FileParseCache<
    ImportSessionRecord | undefined
  >();

  constructor(private readonly options: ClaudeSessionsReaderOptions = {}) {}

  /** The Claude config dir (also where the running registry lives). */
  configDir(): string {
    const env = readerEnv(this.options);
    return (
      this.options.configDir ??
      env.CLAUDE_CONFIG_DIR ??
      join(readerHome(this.options), ".claude")
    );
  }

  async read({ since }: ImportReadOptions): Promise<ImportSourceReading> {
    const root = join(this.configDir(), "projects");
    const files: { path: string; mtimeMs: number; size: number; id: string }[] =
      [];
    for (const slug of await listDir(root)) {
      if (!slug.isDirectory) continue;
      for (const entry of await listDir(join(root, slug.name))) {
        if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
        const path = join(root, slug.name, entry.name);
        const info = await statOrUndefined(path);
        if (info && info.mtimeMs >= since.getTime()) {
          files.push({
            path,
            ...info,
            id: entry.name.slice(0, -".jsonl".length),
          });
        }
      }
    }
    const sessions: ImportSessionRecord[] = [];
    await forEachConcurrently(files, 8, async (file) => {
      const record = await this.cache.get(file.path, file, () =>
        parseClaudeSession(file.path, file.id, file),
      );
      if (record && Date.parse(record.lastActiveAt) >= since.getTime()) {
        sessions.push(record);
      }
    });
    return { sessions, orchestrations: [] };
  }
}

/** Whether a `type:"user"` entry is a human prompt (text, not a tool result, not meta, not a slash-command echo). */
function isTypedPrompt(entry: {
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
}): boolean {
  if (entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.trim() !== "" && !NOT_TYPED.test(content);
  }
  if (!Array.isArray(content)) return false;
  if (content.some((part) => part?.type === "tool_result")) return false;
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  return text.trim() !== "" && !NOT_TYPED.test(text);
}

async function parseClaudeSession(
  path: string,
  fileId: string,
  info: { mtimeMs: number; size: number },
): Promise<ImportSessionRecord | undefined> {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let startedAt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let userPrompts = 0;
  let mainEntries = 0;
  let sidechainEntries = 0;
  try {
    await streamLines(path, (line) => {
      const isUser = line.includes('"type":"user"');
      const isTitle =
        line.includes('"custom-title"') || line.includes('"ai-title"');
      const needsFacts = !cwd && line.includes('"cwd"');
      if (!isUser && !isTitle && !needsFacts) return true;
      let entry: Record<string, unknown> & {
        isMeta?: boolean;
        isSidechain?: boolean;
        message?: { content?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        return true;
      }
      if (
        entry.type === "custom-title" &&
        typeof entry.customTitle === "string"
      ) {
        customTitle = entry.customTitle.trim() || customTitle;
      } else if (
        entry.type === "ai-title" &&
        typeof entry.aiTitle === "string"
      ) {
        aiTitle = entry.aiTitle.trim() || aiTitle;
      }
      if (typeof entry.cwd === "string") {
        if (entry.isSidechain === true) sidechainEntries += 1;
        else mainEntries += 1;
        cwd ??= entry.cwd;
        if (typeof entry.sessionId === "string") sessionId ??= entry.sessionId;
        if (typeof entry.gitBranch === "string" && entry.gitBranch) {
          branch ??= entry.gitBranch;
        }
        startedAt ??= isoOr(entry.timestamp);
      }
      if (entry.type === "user" && isTypedPrompt(entry)) userPrompts += 1;
      return true;
    });
  } catch {
    return undefined;
  }
  if (!cwd) return undefined;
  // A transcript made only of sidechain entries is an agent-internal one.
  if (sidechainEntries > 0 && mainEntries === 0) return undefined;
  const lastActiveAt =
    isoOr(await lastTimestamp(path, info.size)) ??
    new Date(info.mtimeMs).toISOString();
  const title = customTitle ?? aiTitle;
  return {
    harness: "claude-code",
    sessionId: sessionId ?? fileId,
    sessionPath: path,
    cwd,
    ...(startedAt ? { startedAt } : {}),
    lastActiveAt,
    userPrompts,
    ...(title ? { title } : {}),
    ...(branch ? { branch } : {}),
  };
}
