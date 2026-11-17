// Resource Access: token usage of a Cursor chat (docs/costs.md,
// docs/harness-additions.md C5). Called only by the Cursor harness adapter
// (`CursorHarnessAdapter.readSessionUsage` / `recordTurnUsage`).
//
// Cursor's transcript (`…/agent-transcripts/<id>/<id>.jsonl`, verified on
// cursor-agent 2026.11.13) holds only `{role, message: {content}}` lines and
// `{"type":"turn_ended","status":…}`: no tokens, no model. The tokens come
// with each `stop` hook payload, per turn (not running totals):
// `input_tokens` (including the cached part), `output_tokens`,
// `cache_read_tokens`, `cache_write_tokens`, plus `model` and
// `generation_id`; a follow-up turn (`followup_message`) has its own `stop`.
// `harbormaster hook cursor --event stop` reports them
// (`CoreCommands.recordTurnUsage`) and this access appends one JSON line
// per turn to `<stateDir>/harness-usage/cursor/<chat id>.jsonl`; reading
// sums them per model, each generation once. No cost is reported.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessTurnUsage } from "../contracts/commands.js";
import type { SessionUsage } from "../contracts/usage.js";
import { resolveStatePaths } from "../utilities/state-paths.js";
import {
  ModelUsageAccumulator,
  tokenCount,
} from "../utilities/usage-accumulator.js";
import { cursorSessionIdFromPath } from "./cursor-code-access.js";

/** A safe ledger file name for a chat id. */
function ledgerName(sessionId: string): string | undefined {
  return /^[A-Za-z0-9-]+$/.test(sessionId)
    ? `${sessionId.toLowerCase()}.jsonl`
    : undefined;
}

/** Cursor's `stop` payload tokens → buckets: `input_tokens` includes cache reads and writes. */
export function cursorStopUsage(
  payload: Record<string, unknown>,
): Omit<HarnessTurnUsage, "sessionId" | "generation" | "at"> | undefined {
  if (
    payload.input_tokens === undefined &&
    payload.output_tokens === undefined
  ) {
    return undefined;
  }
  const total = tokenCount(payload.input_tokens);
  const cacheRead = tokenCount(payload.cache_read_tokens);
  const cacheWrite = tokenCount(payload.cache_write_tokens);
  return {
    model:
      typeof payload.model === "string" && payload.model
        ? payload.model
        : "unknown",
    input: Math.max(0, total - cacheRead - cacheWrite),
    output: tokenCount(payload.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

/** Sums one ledger's text (pure): each generation once (the last report wins). */
export function parseCursorUsageLedger(
  sessionPath: string,
  text: string,
): SessionUsage {
  const turns = new Map<string, HarnessTurnUsage>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const turn = entry as Partial<HarnessTurnUsage>;
    if (!turn || typeof turn.generation !== "string") continue;
    turns.set(turn.generation, {
      sessionId: String(turn.sessionId ?? ""),
      generation: turn.generation,
      model: typeof turn.model === "string" ? turn.model : "unknown",
      input: tokenCount(turn.input),
      output: tokenCount(turn.output),
      cacheRead: tokenCount(turn.cacheRead),
      cacheWrite: tokenCount(turn.cacheWrite),
    });
  }
  const accumulator = new ModelUsageAccumulator();
  for (const turn of turns.values()) {
    accumulator.add(
      turn.model,
      {
        input: turn.input,
        output: turn.output,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
      },
      undefined,
    );
  }
  return { sessionPath, byModel: accumulator.result() };
}

/** The per-chat token ledger under Harbormaster's state dir. */
export class CursorSessionUsageAccess {
  private readonly dir: string;

  constructor(options: { stateDir?: string } = {}) {
    this.dir = join(
      resolveStatePaths(options.stateDir).harnessUsageDir,
      "cursor",
    );
  }

  async record(usage: HarnessTurnUsage): Promise<void> {
    const name = ledgerName(usage.sessionId);
    if (!name) return;
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, name), `${JSON.stringify(usage)}\n`);
  }

  /** The chat's usage for its transcript path; `undefined` when no turn was ever reported. */
  async read(sessionPath: string): Promise<SessionUsage | undefined> {
    const id = cursorSessionIdFromPath(sessionPath);
    const name = id ? ledgerName(id) : undefined;
    if (!name) return undefined;
    let text: string;
    try {
      text = await readFile(join(this.dir, name), "utf8");
    } catch {
      return undefined;
    }
    const usage = parseCursorUsageLedger(sessionPath, text);
    return usage.byModel.length > 0 ? usage : undefined;
  }
}
