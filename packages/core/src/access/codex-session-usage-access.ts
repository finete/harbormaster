// Resource Access: token usage recorded in a Codex rollout (docs/costs.md
// "Harness file facts", docs/harness-additions.md X11), read-only. Called
// only by the Codex harness adapter (`CodexHarnessAdapter.readSessionUsage`).
//
// Format (verified on disk 2026-11-17, codex-cli 0.169.0,
// `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, one JSON object
// per line `{ timestamp, ordinal, type, payload }`):
// - `session_meta`: `payload.id` = the session id; a fork also carries
//   `forked_from_id` and references the parent's history instead of copying
//   it (`history_mode: "paginated"`), so a fork's file holds only its own
//   turns.
// - `turn_context`: `payload.turn_id`, `payload.model`, `payload.effort`,
//   one per turn (the model can change between turns).
// - `token_usage_record`: one per model response, `payload.{ thread_id,
//   turn_id, response_id, usage: { input_tokens, cached_input_tokens,
//   cache_write_input_tokens, output_tokens, reasoning_output_tokens,
//   total_tokens } }`. `input_tokens` includes the cached part and
//   `output_tokens` the reasoning part (OpenAI's accounting).
// - `event_msg` / `token_count`: the same figures as running totals
//   (`info.total_token_usage`, `info.last_token_usage`); used only for a
//   rollout without `token_usage_record` lines (older Codex), counting each
//   increase of the running total once.
// - No cost is written.

import { readFile } from "node:fs/promises";
import type { SessionUsage, TokenBuckets } from "../contracts/usage.js";
import {
  ModelUsageAccumulator,
  tokenCount,
} from "../utilities/usage-accumulator.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** OpenAI usage → buckets: cached input is cache read, never double-counted as input. */
export function codexUsageBuckets(
  usage: Record<string, unknown>,
): TokenBuckets {
  const input = tokenCount(usage.input_tokens);
  const cached = Math.min(tokenCount(usage.cached_input_tokens), input);
  return {
    input: input - cached,
    output: tokenCount(usage.output_tokens),
    cacheRead: cached,
    cacheWrite: tokenCount(usage.cache_write_input_tokens),
  };
}

/** Parse one rollout's text (pure). */
export function parseCodexSessionUsage(
  sessionPath: string,
  text: string,
): SessionUsage {
  let sessionId: string | undefined;
  let model = "unknown";
  const turnModels = new Map<string, string>();
  const responses = new Map<string, { model: string; buckets: TokenBuckets }>();
  let anonymous = 0;
  const fallback: Array<{ model: string; buckets: TokenBuckets }> = [];
  let lastTotal = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = record(entry?.payload);
    if (!entry || !payload) continue;
    switch (entry.type) {
      case "session_meta":
        if (typeof payload.id === "string") sessionId ??= payload.id;
        break;
      case "turn_context":
        if (typeof payload.model === "string" && payload.model) {
          model = payload.model;
          if (typeof payload.turn_id === "string") {
            turnModels.set(payload.turn_id, payload.model);
          }
        }
        break;
      case "token_usage_record": {
        // A record copied from another thread (a fork's prefix) was spent there.
        if (
          sessionId &&
          typeof payload.thread_id === "string" &&
          payload.thread_id !== sessionId
        ) {
          break;
        }
        const usage = record(payload.usage);
        if (!usage) break;
        const turnModel =
          typeof payload.turn_id === "string"
            ? turnModels.get(payload.turn_id)
            : undefined;
        const key =
          typeof payload.response_id === "string" && payload.response_id
            ? payload.response_id
            : `anonymous-${anonymous++}`;
        responses.set(key, {
          model: turnModel ?? model,
          buckets: codexUsageBuckets(usage),
        });
        break;
      }
      case "event_msg": {
        if (payload.type !== "token_count") break;
        const info = record(payload.info);
        const total = tokenCount(record(info?.total_token_usage)?.total_tokens);
        const last = record(info?.last_token_usage);
        if (!last || total <= lastTotal) break;
        lastTotal = total;
        fallback.push({ model, buckets: codexUsageBuckets(last) });
        break;
      }
    }
  }
  const all = new ModelUsageAccumulator();
  const counted = responses.size > 0 ? [...responses.values()] : fallback;
  for (const response of counted) {
    all.add(response.model, response.buckets, undefined);
  }
  return { sessionPath, byModel: all.result() };
}

/** Read one Codex rollout; `undefined` when it is missing. */
export async function readCodexSessionUsage(
  sessionPath: string,
): Promise<SessionUsage | undefined> {
  if (!sessionPath) return undefined;
  let text: string;
  try {
    text = await readFile(sessionPath, "utf8");
  } catch {
    return undefined;
  }
  return parseCodexSessionUsage(sessionPath, text);
}
