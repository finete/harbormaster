// Resource Access: token usage recorded in a Claude Code transcript
// (docs/costs.md "Harness file facts"), read-only. Called only by the
// Claude Code harness adapter (`ClaudeCodeHarnessAdapter.readSessionUsage`).
//
// Format (verified on disk 2026-11-16, Claude Code 2.1.x,
// `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`):
// - Assistant entries are `{ "type": "assistant", "requestId",
//   "isSidechain", "sessionId", "timestamp", "message": { "id", "model",
//   "usage": { "input_tokens", "output_tokens", "cache_read_input_tokens",
//   "cache_creation_input_tokens", ... } } }`.
// - One API request is written as several lines (one per content block),
//   each repeating the request's usage under the same `requestId` /
//   `message.id`: each request counts once (per bucket, the largest value
//   seen, in case an early chunk carried partial output).
// - One session mixes models (`claude-opus-*` with `claude-haiku-*` side
//   calls); `"<synthetic>"` entries are local error stand-ins, never billed.
// - `isSidechain` turns are real requests and count.
// - No cost is written per turn (a `cost-state` entry exists in newer
//   versions but is a running UI figure, not used: docs/costs.md decision 3).
//
// Not seen on disk (no such files existed); taken from the Claude Code
// 2.1.325 bundle instead:
// - Subagent transcripts: `<projectDir>/<sessionId>/subagents/[<sub>/]
//   agent-<agentId>.jsonl` (current layout), or older sibling
//   `<projectDir>/agent-<agentId>.jsonl` files whose entries carry the
//   owning session's `sessionId`. Both are included.
// - A `--fork-session` copy marks copied entries with `"forkedFrom": {
//   "sessionId", "messageUuid" }`; those turns are the fork prefix.

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ModelUsage,
  SessionUsage,
  TokenBuckets,
} from "../contracts/usage.js";
import {
  ModelUsageAccumulator,
  tokenCount,
} from "../utilities/usage-accumulator.js";

/** Claude's placeholder model on locally generated (never billed) entries. */
const SYNTHETIC_MODEL = "<synthetic>";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface Request {
  model: string;
  buckets: TokenBuckets;
  /** Copied from another session by `--fork-session` (its id). */
  forkedFromSession?: string;
}

/** Requests across the main transcript and its subagent files, deduped by `requestId` / `message.id`. */
class RequestLedger {
  private readonly requests = new Map<string, Request>();
  private anonymous = 0;

  addText(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let entry: Record<string, unknown> | undefined;
      try {
        entry = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (entry?.type !== "assistant") continue;
      const message = record(entry.message);
      const usage = record(message?.usage);
      if (!message || !usage) continue;
      const model =
        typeof message.model === "string" && message.model
          ? message.model
          : "unknown";
      if (model === SYNTHETIC_MODEL) continue;
      const buckets: TokenBuckets = {
        input: tokenCount(usage.input_tokens),
        output: tokenCount(usage.output_tokens),
        cacheRead: tokenCount(usage.cache_read_input_tokens),
        cacheWrite: tokenCount(usage.cache_creation_input_tokens),
      };
      const forkedFrom = record(entry.forkedFrom)?.sessionId;
      const key =
        (typeof entry.requestId === "string" && entry.requestId) ||
        (typeof message.id === "string" && message.id) ||
        `anonymous:${this.anonymous++}`;
      const seen = this.requests.get(key);
      if (!seen) {
        this.requests.set(key, {
          model,
          buckets,
          ...(typeof forkedFrom === "string" && forkedFrom
            ? { forkedFromSession: forkedFrom }
            : {}),
        });
        continue;
      }
      seen.buckets = {
        input: Math.max(seen.buckets.input, buckets.input),
        output: Math.max(seen.buckets.output, buckets.output),
        cacheRead: Math.max(seen.buckets.cacheRead, buckets.cacheRead),
        cacheWrite: Math.max(seen.buckets.cacheWrite, buckets.cacheWrite),
      };
    }
  }

  usage(sessionPath: string): SessionUsage {
    const all = new ModelUsageAccumulator();
    const prefix = new ModelUsageAccumulator();
    let prefixTurns = 0;
    let parent: string | undefined;
    for (const request of this.requests.values()) {
      all.add(request.model, request.buckets, undefined);
      if (request.forkedFromSession) {
        parent ??= request.forkedFromSession;
        prefixTurns += 1;
        prefix.add(request.model, request.buckets, undefined);
      }
    }
    const byModel: ModelUsage[] = all.result();
    return {
      sessionPath,
      byModel,
      ...(parent
        ? {
            forkedFrom: {
              sessionPath: join(dirname(sessionPath), `${parent}.jsonl`),
              turns: prefixTurns,
              prefix: prefix.result(),
            },
          }
        : {}),
    };
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every `agent-*.jsonl` under `dir`, recursively (missing dir = none). */
async function agentFilesUnder(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await agentFilesUnder(path)));
    else if (
      entry.isFile() &&
      entry.name.startsWith("agent-") &&
      entry.name.endsWith(".jsonl")
    ) {
      found.push(path);
    }
  }
  return found.sort();
}

/** The `sessionId` an (older-layout) sibling agent transcript belongs to. */
function owningSession(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.includes('"sessionId"')) continue;
    try {
      const sessionId = record(JSON.parse(line))?.sessionId;
      if (typeof sessionId === "string") return sessionId;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Parse transcript texts (pure): the main session first, then its subagent files. */
export function parseClaudeSessionUsage(
  sessionPath: string,
  texts: readonly string[],
): SessionUsage {
  const ledger = new RequestLedger();
  for (const text of texts) ledger.addText(text);
  return ledger.usage(sessionPath);
}

/**
 * Read one Claude Code session (`<projectDir>/<sessionId>.jsonl`) plus its
 * subagent transcripts; `undefined` when the main file is missing.
 */
export async function readClaudeSessionUsage(
  sessionPath: string,
): Promise<SessionUsage | undefined> {
  if (!sessionPath) return undefined;
  const main = await readText(sessionPath);
  if (main === undefined) return undefined;
  const projectDir = dirname(sessionPath);
  const sessionId = basename(sessionPath, ".jsonl");
  const texts = [main];
  for (const path of await agentFilesUnder(
    join(projectDir, sessionId, "subagents"),
  )) {
    const text = await readText(path);
    if (text !== undefined) texts.push(text);
  }
  let siblings: string[] = [];
  try {
    siblings = (await readdir(projectDir))
      .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
      .sort();
  } catch {
    siblings = [];
  }
  for (const name of siblings) {
    const text = await readText(join(projectDir, name));
    if (text !== undefined && owningSession(text) === sessionId) {
      texts.push(text);
    }
  }
  return parseClaudeSessionUsage(sessionPath, texts);
}
