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
| 5 | Multi-session | Sum over the task's sessions (`sessionPath` + `previousSessionPath` from the binding). A forked session subtracts the shared prefix. Subtasks (`parentTaskId`) count on their own card; the parent additionally shows *"incl. N subtasks"*, where the subtasks are every task below it at any depth, each counted once (`docs/task-trees.md` decision 14). Per-model breakdown is stored, not just totals. |
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
files) makes recomputation cheap; `TaskUsage.lastActivityAt` (see
follow-up 2) dates the spend; `listTaskUsage(query?)` takes an optional
`TaskUsageQuery`; `refreshTaskUsage` resolves to `TaskUsage | undefined`;
`TaskUsageRow.repository` is `repositoryId`, else `folderPath`, else `""`.
The Claude adapter gained `expectedSessionFile` so core can locate
transcripts without a `recordTaskSession` call. Socket ops `usage` and
`usage_refresh` expose both commands to the CLI.

## Follow-ups (2026-11-16, after shipping on a 229-task board)

1. **Backfill drain.** The refresh no longer counts 16 never-computed
   tasks per tick (229 tasks took 10+ minutes at the app's 30s cadence).
   Every refresh tick (the first one runs at startup) starts a background
   drain, unless one is already running (single-flight): it queues every
   task the backfill still owes a first figure (Done, or bound to a
   session: `awaitsUsageBackfill`), computes them in batches of 16 with 4
   in flight, yields to the event loop between batches and pushes the board
   at most once per batch. The tick never waits for it
   (`CoreManager.whenUsageBackfilled()` does, for hosts and tests).
   `pending` tasks are still re-checked on every tick; `unavailable` is
   still never retried. Measured: 229 tasks × 268 KB Pi transcripts drain
   in ~1.3 s (15 board pushes); 40 in ~0.2 s.
2. **Activity time.** `TaskUsage.lastActivityAt` = the newest mtime among
   the task's session files (from the stats already taken for the
   fingerprint; unset when they can't be stat'ed). The Costs range filter
   (`usageActivityAt`) is `usage.lastActivityAt ?? completedAt ??
   updatedAt`; `computedAt` is never used for filtering (a backfill
   counting an old task today put it in "This week"). A `ready` usage
   persisted without the field is queued once per process by the drain
   and gains it from the stats alone (unchanged fingerprint: no re-parse).
3. **"Still counting".** `listTaskUsage` keeps returning `TaskUsageRow[]`
   (smallest blast radius: the CLI prints such a row as `pending`), but
   also lists tasks the backfill has not counted yet as `pending` rows
   with zero totals. The Costs view hides `pending` rows from the table,
   group-by and CSV and appends "· counting N more…" to the totals line
   until none remain (`unavailable` rows still show `n/a`). A task whose
   session is genuinely still pending (bound, transcript not written yet)
   counts there too until its transcript appears or it is Done.
4. **Subtask roll-up in the Costs table.** A row with `subtaskUsage` leads
   with the inclusive figure (own + subtasks, bold, the one the Tokens /
   Est. $ columns sort on) and shows own usage muted after it: `"581M ·
   own 68M"`, `"~$4.25 · own ~$3.50"` (the `$` only when both are
   priced). When the two read the same at the displayed precision
   (`formatTokenCount`, `$` at 2 decimals) only the single figure shows;
   the title carries a `⤷ N subtasks` marker either way. The totals line
   still sums own usage only (tooltip: "own usage per task; subtasks
   counted once"); the CSV keeps separate own and subtask columns.
5. **Search.** A "Filter tasks…" box (`costs-search`, right of the filter
   row) narrows rows by a case-insensitive substring of the title,
   repository, harness or model ids, before totals, group-by and CSV
   (what you see is what you export). Esc in the box clears it (Esc
   elsewhere still leaves the page); no match shows "0 tasks".

## Harness file facts (verified on disk 2026-11-16)

- **Pi** `~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`: assistant messages carry `usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }` and a `model`. `cost` is Pi's own list-price estimate (`pi-ai` `calculateCost`).
- **Claude Code** `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`: assistant entries carry `message.model`, `message.usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }`, `requestId`, `isSidechain`. The same `requestId` appears on several lines (streamed chunks repeat the full usage): count each request once. One session mixes `claude-opus-*` with `claude-haiku-*` (side calls). Newer versions write subagent transcripts to sibling `agent-*.jsonl` files.

## Testing bar

Unit: each adapter parser against fixture JSONL (Pi: cost pass-through, fork prefix; Claude: requestId dedupe, sidechain, model mix); snapshot/backfill rules; `listTaskUsage` filters and subtask roll-up; `formatTokenCount`. E2E: one for the chip + popover, one for the Costs view, one for CSV; each shown to fail with its feature reverted. Full gate once at the end.
