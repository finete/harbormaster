// Resource Access: token usage recorded in a Pi session file (docs/costs.md
// "Harness file facts"), read-only. Called only by the Pi harness adapter
// (`PiHarnessAdapter.readSessionUsage`); core never reads Pi's JSONL itself.
//
// Format (verified on disk 2026-11-16, `~/.pi/agent/sessions/<cwd-slug>/
// <ts>_<uuid>.jsonl`):
// - Line 1 is the header `{ "type": "session", "id", "timestamp", "cwd" }`;
//   a forked session's header also carries `"parentSession": "<path of the
//   parent session file>"`.
// - Assistant turns are `{ "type": "message", "timestamp": "<ISO>",
//   "message": { "role": "assistant", "provider", "model", "usage": {
//   "input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost": {
//   "input", "output", "cacheRead", "cacheWrite", "total" } } } }`. `cost`
//   is Pi's own list-price estimate, passed through as-is.
// - A fork copies the parent's entries (same ids, original timestamps) to
//   the top of the new file. On every fork on disk the copied assistant
//   turns were exactly those timestamped before the header's `timestamp`,
//   and always a prefix; that is how the copied prefix is told apart.

import { readFile } from "node:fs/promises";
import type { ModelUsage, SessionUsage } from "../contracts/usage.js";
import {
  ModelUsageAccumulator,
  tokenCount,
} from "../utilities/usage-accumulator.js";

/** The label `cost` is attributed to (docs/costs.md decision 3). */
export const PI_COST_SOURCE = "pi";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timeMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Parse a Pi session's JSONL text (pure; `sessionPath` is only echoed back). */
export function parsePiSessionUsage(
  text: string,
  sessionPath: string,
): SessionUsage {
  const all = new ModelUsageAccumulator();
  const prefix = new ModelUsageAccumulator();
  let prefixTurns = 0;
  let turns = 0;
  let parentSession: string | undefined;
  let forkedAtMs: number | undefined;
  let headerSeen = false;
  let priced = false;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // Cheap pre-filter: only the header and assistant turns are parsed
    // (a long session is mostly tool output).
    const header = !headerSeen;
    if (!header && !line.includes('"assistant"')) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    if (header && entry.type === "session") {
      headerSeen = true;
      if (typeof entry.parentSession === "string" && entry.parentSession) {
        parentSession = entry.parentSession;
        forkedAtMs = timeMs(entry.timestamp);
      }
      continue;
    }
    headerSeen = true;
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "assistant") continue;
    const usage = record(message.usage);
    if (!usage) continue;
    const model =
      typeof message.model === "string" && message.model
        ? message.model
        : "unknown";
    const buckets = {
      input: tokenCount(usage.input),
      output: tokenCount(usage.output),
      cacheRead: tokenCount(usage.cacheRead),
      cacheWrite: tokenCount(usage.cacheWrite),
    };
    const total = record(usage.cost)?.total;
    const cost =
      typeof total === "number" && Number.isFinite(total) ? total : undefined;
    if (cost !== undefined) priced = true;
    all.add(model, buckets, cost);
    turns += 1;
    const at = timeMs(entry.timestamp);
    if (
      forkedAtMs !== undefined &&
      at !== undefined &&
      at < forkedAtMs &&
      // copied turns are a prefix: stop at the first turn of this session
      prefixTurns === turns - 1
    ) {
      prefixTurns += 1;
      prefix.add(model, buckets, cost);
    }
  }

  const byModel: ModelUsage[] = all.result();
  return {
    sessionPath,
    byModel,
    ...(parentSession
      ? {
          forkedFrom: {
            sessionPath: parentSession,
            turns: prefixTurns,
            prefix: prefix.result(),
          },
        }
      : {}),
    ...(priced ? { costSource: PI_COST_SOURCE } : {}),
  };
}

/** Read and parse one Pi session file; `undefined` when it is missing or unreadable. */
export async function readPiSessionUsage(
  sessionPath: string,
): Promise<SessionUsage | undefined> {
  if (!sessionPath) return undefined;
  let text: string;
  try {
    text = await readFile(sessionPath, "utf8");
  } catch {
    return undefined;
  }
  return parsePiSessionUsage(text, sessionPath);
}
