# Costs: per-task token usage

Decisions from a grilled design interview, 2026-11-16. Amend this file when a
decision is revisited; do not silently diverge. Research that informed it:
AWS Cost Explorer ("can't answer *what changed*", 24h lag), Cursor's removal
of `$` from its usage page (HN 49135257: users want $ *and* tokens, labelled),
Claude Code `/cost` (session-only, under-reported vs. the bill, #1063/#78148),
ccusage / Splunk Token Meter ("estimates are labelled; missing evidence stays
unavailable, never zero").

## Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Primary job | **"What did this task cost me?"** Per-task accountability. Diagnostics ("why was it expensive") later; burn-rate / plan-limit projection is out of scope. |
| 2 | Unit | **Tokens are the primary, always-visible figure** (input / output / cache read / cache write, per model). `$` is secondary and never shown bare. |
| 3 | Dollars | **No price table in Harbormaster.** `$` appears only when the harness itself wrote a cost into its transcript (Pi does; Claude Code does not). Shown as `~$4.20` with the label *"est. by Pi at list price · not your bill"*. Harnesses without cost show `—`. |
| 4 | Data flow | **Adapter parses, core persists.** Each harness adapter implements `readSessionUsage(sessionPath)`; core sums it into `task.usage` on session-recorded / agent-finished / toDone events, plus a one-shot backfill for existing tasks. Frontends read task state only. No live tail in v1. |
| 5 | Multi-session | Sum over the task's sessions (`sessionPath` + `previousSessionPath` from the binding). A forked session subtracts the shared prefix. Subtasks (`parentTaskId`) count on their own card; the parent additionally shows *"incl. N subtasks"*. Per-model breakdown is stored, not just totals. |
| 6 | Harness quirks live in the adapter | Claude Code: dedupe repeated `usage` on the same `requestId`/`message.id`, include `isSidechain` turns and sibling `agent-*.jsonl` subagent files, mixed models per session. Pi: `usage.cost` pass-through, fork prefix. Custom CLI: `readSessionUsage` undefined → `usage: { status: "unavailable" }`. |
| 7 | UI surfaces | (a) usage chip in the task-workspace header next to the audit trail, click → popover (primary); (b) muted usage line on board cards on hover / top-3 most expensive in view; (c) **Costs** sidebar view, sibling of Rules / Inbox: filters (range, repo, harness, model), totals line, ranked table (tokens desc), group-by Task / Repo / Harness / Model. No charts. |
| 8 | History | No task deletion exists in the UI; `archivedAt` is a flag. Costs view includes archived tasks; the range picker is a filter, not retention. Backfill marks tasks whose session files are gone as `unavailable` once; never retried. |
| 9 | Export | Core query `listTaskUsage` is exposed to every frontend; CLI gets `harbormaster usage --json`; the app gets a minimal **Export CSV** (flat rows = table rows, save dialog, no options). |
| 10 | Delivery | All in one go, three subagent lanes: core, then app + CLI in parallel. Full gate once at the end. |

## Contracts

```ts
// packages/core/src/contracts/usage.ts
export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsage extends TokenBuckets {
  model: string;         // harness-reported id, e.g. "claude-opus-5-5"
  turns: number;         // assistant turns attributed to this model
  cost?: number;         // USD, only when the harness wrote it
}

/** What an adapter returns for one session file. */
export interface SessionUsage {
  sessionPath: string;
  byModel: ModelUsage[];
  /** Set when this session was forked from another: usage up to `turns` of `sessionPath` is already counted there. */
  forkedFrom?: { sessionPath: string; turns: number };
  /** Harness that priced `cost` (label source), e.g. "pi". Absent when no cost. */
  costSource?: string;
}

/** Persisted on the task. */
export interface TaskUsage {
  status: "ready" | "unavailable" | "pending";
  /** Why unavailable: harness has no reader, or session files are gone. */
  reason?: "unsupported" | "missing-session";
  totals: TokenBuckets & { turns: number };
  byModel: ModelUsage[];
  sessions: Array<{ sessionPath: string; harness: string; totals: TokenBuckets; cost?: number }>;
  /** Sum of `cost` across sessions, only if every priced session had one. */
  cost?: number;
  costSource?: string;
  computedAt: string;
}
```

- `Task.usage?: TaskUsage` on `contracts/model.ts`.
- `HarnessAdapter.readSessionUsage?(sessionPath: string): Promise<SessionUsage | undefined>` on `contracts/harness.ts`. Optional; `undefined` = file unreadable / missing.
- `CoreCommands.listTaskUsage(query: { from?: string; to?: string; repository?: string; harness?: string; model?: string; includeArchived?: boolean }): Promise<TaskUsageRow[]>` where a row is `{ taskId, title, repository, harness, state, completedAt?, usage: TaskUsage, subtaskUsage?: TokenBuckets & { count: number; cost?: number } }`.
- `CoreCommands.refreshTaskUsage(taskId)` recomputes one task (used by the popover's refresh and the backfill).
- Utility `formatTokenCount(n)` → `"9.8M"`, `"92k"`, `"412"` in `packages/core/src/utilities/`.

Implementation notes (additive to the shapes above; see `contracts/usage.ts`):
`SessionUsage.forkedFrom.prefix` carries the copied prefix per model so the
engine can subtract it; `TaskUsage.fingerprint` (size/mtime of the session
files) makes recomputation cheap; `listTaskUsage(query?)` takes an optional
`TaskUsageQuery`; `refreshTaskUsage` resolves to `TaskUsage | undefined`;
`TaskUsageRow.repository` is `repositoryId`, else `folderPath`, else `""`.
The Claude adapter gained `expectedSessionFile` so core can locate
transcripts without a `recordTaskSession` call. Socket ops `usage` and
`usage_refresh` expose both commands to the CLI.

## Harness file facts (verified on disk 2026-11-16)

- **Pi** `~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`: assistant messages carry `usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }` and a `model`. `cost` is Pi's own list-price estimate (`pi-ai` `calculateCost`).
- **Claude Code** `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`: assistant entries carry `message.model`, `message.usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }`, `requestId`, `isSidechain`. The same `requestId` appears on several lines (streamed chunks repeat the full usage): count each request once. One session mixes `claude-opus-*` with `claude-haiku-*` (side calls). Newer versions write subagent transcripts to sibling `agent-*.jsonl` files.

## Testing bar

Unit: each adapter parser against fixture JSONL (Pi: cost pass-through, fork prefix; Claude: requestId dedupe, sidechain, model mix); snapshot/backfill rules; `listTaskUsage` filters and subtask roll-up; `formatTokenCount`. E2E: one for the chip + popover, one for the Costs view, one for CSV; each shown to fail with its feature reverted. Full gate once at the end.
