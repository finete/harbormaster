# Import existing work

Decision record for bringing a new user's work in progress (Claude Code,
Codex, Pi, Cursor sessions, and herdr workspaces) onto the board as tasks
(grilling session, 2026-11-22; facts verified 2026-11-24). Where this file
and older docs disagree about importing, this file wins.

Research basis: Pane (runpane.com/docs/importing: first-run "bring sessions
from the last 7 days", External label, refuses running sessions,
`panes adopt --dry-run`), Agentastic (agentastic.dev/docs/how-to/import-from-other-apps:
review before apply, Undo, session refs only), Orca (orca.dev/docs/migrate-from-conductor:
worktrees opened in place, nothing copied; /docs/agents/session-history), the
herdr-import mod (github.com/arhen/herdr-import: one dialog, sessions resumed
in place, source untouched).

## Decisions

| # | Decision |
|---|---|
| I1 | **Unit of import = one folder (worktree or checkout) + its sessions = one task**, matching task = one worktree + one bound session. The user picks which items to import; nothing comes in unselected. |
| I2 | **Sources v1:** the agent session stores we have adapters for (Pi, Claude Code, Codex, Cursor; facts F1-F5), grouped by the cwd recorded in each session; plus **herdr (the TUI)** as the first orchestrator source, adding workspace names, grouping and running status (F7). Not the herdr desktop app (herdr-core/`hc`), not Conductor/Orca/Superset (later: one reader each behind the same `ImportSourceReader` interface). |
| I3 | **Session running elsewhere:** the row is shown disabled with the reason ("Running in herdr: close it there" / "Running in a terminal: close it there") + **Check again**, and an explicit per-row **Fork instead** that imports a fork of the session. Never attach to a foreign live session. Fork instead exists only where the agent can fork, read from the adapter (`HarnessCapabilities.fork`, never a hardcoded agent list; today Pi, Claude Code, Codex; **not Cursor**, F8): a running Cursor row offers Check again only. Running detection is **conservative** (I13): a false "running" only costs a Check again or a fork; a missed one lets two writers corrupt a session. (Confirmed by the parent task, 2026-11-24.) |
| I4 | **Entry points:** an onboarding wizard step (primary: "Bring in your recent work?"), a durable **Import…** entry in the "+ New" menu and a Settings row, and a **CLI/MCP command**. All four are thin clients of the same core commands. |
| I5 | **List:** items with session activity in the last **30 days** (+ "show older"); **last 7 days pre-ticked**; items whose sessions are all tiny (< 3 human prompts) or whose folder no longer exists are hidden behind "show hidden"; **grouped by repository**, newest first, per-repository select-all; items already on the board show "already in Harbormaster" and are not selectable (no duplicates). |
| I6 | **Column:** every imported task enters the same way (**Working**, like a started task) and the **existing rules place it**; no import-specific column logic. Items whose PR is merged or closed are listed unticked with a "merged" / "closed" label; if ticked they follow the rules like any other. |
| I7 | **Title:** the first available of herdr workspace name → PR title → session title (Claude `/rename` or AI title, Pi session name, Codex thread name, Cursor chat title) → branch, humanized → folder name. Editable per row before import; a small grey hint shows the source. |
| I8 | **Several sessions in one folder:** bind the **most recent** by default, with a per-row **picker** (agent icon, title, last active, prompt count; the row says "+N other sessions"). The picked session fixes the task's agent. Unpicked sessions are left untouched. A per-task session-history panel is a separate follow-up. |
| I9 | **Ownership:** an imported linked worktree is **External** (`WorkspaceBinding.external: true`). Done, Archive, the 7-day sweep, rules and Undo NEVER remove an external folder or delete its branch; they only release the task's hold on the session. Done's question says "The worktree <path> isn't Harbormaster's and will be kept." Removing it is a separate explicit **Remove worktree…** task action with the same safety lines as Done. A session from a repository's **main checkout** (or a non-git folder) becomes a **folder task** (never removable). Enforced in core's cleanup, not the UI. |
| I10 | **After import:** one **inbox item** summarizing what came in and what was left out with reasons ("Imported 12 tasks from Claude Code, Codex and herdr · 3 left out (running elsewhere: 2, folder missing: 1)") with **Show on board** and **Undo import**. Every task records its import batch id; `undoImport(batchId)` removes the batch's tasks not opened or changed since, and keeps and lists the touched ones. |
| I11 | **No automatic or ongoing import.** Import runs only when asked; re-running shows only new items (imported ones are "already in Harbormaster"). |
| I12 | **Tasks only.** No skills/MCP/settings import: Harbormaster runs the user's real CLIs, so their setup already works; the onboarding step says so ("Your Claude Code / Codex setup works as-is."). No setup-script import. |

Owner decisions made while writing this file (not reopened from the grill,
recorded so they can be challenged):

| # | Decision |
|---|---|
| I13 | **Running detection is session-exact only for Claude Code; everywhere else it is conservative.** Claude Code publishes which session each process holds (F3). For Pi, Codex and Cursor, an agent process of that harness running in the item's folder (cwd, F6) marks **every** session of that harness in that folder as running, so the picker (I8) can never import an older session that is actually the live one. Sessions of other harnesses in the same folder stay pickable. (Set by the parent task, 2026-11-24.) |
| I14 | **Leaving Done on an External task reopens it in its own folder.** Reopen/Resume of an External task whose folder still exists resumes there on the same branch (no new Harbormaster worktree); if the folder is gone, it reopens like any task (fresh Harbormaster worktree, no longer External). |
| I15 | **Remove worktree… is offered on Done (and archived) External tasks only** and removes the folder, never the branch ("The branch <name> is kept."). An unfinished task is marked Done first. |
| I16 | **Importing a worktree of a repository Harbormaster does not know registers its main checkout** as a known location (as "Open folder…" does), so the task gets a real `repositoryId`, PR linkage and its repo group. |
| I17 | **Agent-internal sessions are not import sessions:** Claude subagent transcripts and sidechains, pi-subagents child sessions (nested directories, F1), Codex non-interactive `exec` sessions. Sessions Harbormaster itself started are already on the board (session-id dedupe). |

## Verified facts

Verified on this Mac on 2026-11-24 against the real stores and CLIs
(pi 1.5.2, Claude Code 2.1.326, codex-cli 0.170.0, cursor-agent
2026.11.22-e9042b2, herdr 0.9.5). Readers must be built against **recorded
fixtures from these CLIs** (see "Fixtures"), never hand-written imitations.

| # | Fact |
|---|---|
| F1 | **Pi** (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`): `sessions/--<cwd slug>--/<ISO>_<id>.jsonl`. Line 1 is the header `{type:"session", version:3, id, timestamp, cwd, parentSession?}` (`parentSession` = forked from). Title = the last `{type:"session_info", name}`. Human prompts = `{type:"message", message:{role:"user"}}` entries (`custom_message` entries such as `harbormaster-message` are injected, not typed). pi-subagents child sessions live in **nested** directories (`<slug>/<parent>/<id>/run-0/session.jsonl`, named `subagent-…`): read only `<slug>/*.jsonl`. |
| F2 | **Claude Code** (`$CLAUDE_CONFIG_DIR`, else `~/.claude`): `projects/<slug>/<sessionId>.jsonl`. The slug is lossy (every `/` and `.` → `-`): take `cwd` from the entries, never from the dir name. Every message entry has `cwd`, `gitBranch`, `timestamp`, `sessionId`, `isSidechain`. Titles: `{type:"custom-title", customTitle}` (`/rename`, wins) and `{type:"ai-title", aiTitle}`. Human prompts = `type:"user"` entries whose content is text (not `tool_result`), not `isMeta`, not `isSidechain`. Subagent transcripts live under `projects/<slug>/<sessionId>/subagents/`. |
| F3 | **Claude Code running registry:** each live `claude` writes `~/.claude/sessions/<pid>.json` = `{pid, sessionId, cwd, startedAt, procStart, status, kind, name, …}`. Valid only while that pid is alive and its start time matches `procStart` (a crashed process leaves a stale file). Session-exact running detection. |
| F4 | **Codex** (`$CODEX_HOME`, else `~/.codex`): `sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl`. Line 1 `{type:"session_meta", payload:{id, timestamp, cwd, originator ("codex-tui"), source ("cli" \| "exec"), cli_version, git:{branch, commit_hash, repository_url}}}`. Thread names: `session_index.jsonl` lines `{id, thread_name, updated_at}` (last line per id wins). Human prompts: `response_item` messages with `role:"user"` minus injected context (`<environment_context>`, AGENTS.md); confirm against a fresh recording whether `event_msg` `user_message` is the cleaner count. `thread-writer-locks/<id>.lock` (empty files) exist; whether they mark a live writer is **unverified**: do not rely on them without a recording that proves it. A Codex app-server daemon (desktop/IDE threads) may run with no per-thread process. |
| F5 | **Cursor** (config dir `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`; data dir `$CURSOR_DATA_DIR`, else `~/.cursor`): `chats/<md5(cwd)>/<chatId>/meta.json` = `{schemaVersion:1, createdAtMs, updatedAtMs, title, cwd, hasConversation}`, plus `prompt_history.json` (array of typed prompts) and `store.db` (SQLite; not needed). Older chats lack `meta.json`: skip them or fall back to the transcript `<data>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (`{role, message:{content:[{type:"text", text:"<user_query>…"}]}}`). |
| F6 | **Agent processes** (`ps -axo pid,comm,args` + `lsof -a -d cwd -p <pids> -Fpn`, both verified): Pi = comm `pi` (Pi rewrites its process title; argv is not visible), Claude = comm `claude`, Codex = the vendor binary `…/codex-darwin-arm64/vendor/…/bin/codex` (exclude `codex app-server`), Cursor = `…/.local/bin/agent … cursor-agent/versions/<v>/index.js`. Pi publishes no registry and its exec env carries no session id (`PI_SESSION_ID` is set only for its children), so Pi, Codex and Cursor are folder-level, applied conservatively (I13). |
| F7 | **herdr** 0.9.5 (`brew install herdr`): state under `$XDG_CONFIG_HOME/herdr/` (else `~/.config/herdr/`; `XDG_CONFIG_HOME` verified honored). `herdr session list --json` → `{sessions:[{default, name, running, session_dir, socket_path}]}` (verified); each session dir has its own `session.json`. Per herdr's `src/persist/snapshot.rs` (to be confirmed by the recorded fixture): `SNAPSHOT_VERSION = 3`, legacy versions still parsed; `workspaces[]{id?, custom_name?, identity_cwd, worktree_space?, tabs[]{custom_name?, panes{<n>:{cwd, agent_name?, agent_session?{source, agent, kind:"id"\|"path", value}, agent_resume?{source, agent, argv}, launch_argv?}}}}`. Live panes: `herdr api snapshot` → `result.snapshot.panes[]` with `agent_status` and `agent_session` (needs a running server; the reader treats "server not running" as "nothing live"). Recorded (`scripts/record-herdr-fixtures.mjs`) with real Pi and Claude Code panes: Pi is `agent_session {agent:"pi", kind:"path", value:<session file>}`, Claude Code is `{agent:"claude", kind:"id", value:<session id>}`; both need herdr's agent integration (`herdr integration install pi|claude`), which the recorder installs only when absent and removes again, restoring `~/.claude/settings.json` byte-for-byte. A Claude pane whose turn ended reads `agent_status: "done"` while its process still holds the session, so a live `agent` counts as running. Inside herdr, Claude's folder-trust dialog starts on "No, exit". |
| F8 | **Fork support:** Pi `--fork <path> --session-id <id>`; Claude `--resume <from> --fork-session --session-id <id>`; Codex `fork <id>`. **Cursor has no fork** (`agent --help`, 2026.11.22: `--resume [chatId]`, `--continue`, `ls`, `resume`, `create-chat`; `cursorSessionArgs` maps a fork to a resume of the same chat). Core learns this from a new adapter capability `HarnessCapabilities.fork: boolean` (data, asserted by the harness contract test), not from agent names. |
| F9 | **Git:** a linked worktree has `git rev-parse --git-dir` ≠ `--git-common-dir`; the main checkout is the common dir's parent. PR state + title per branch: `GithubPrAccess.statusMany` (one GraphQL batch per repository; `title` must be added to its fields; `view` already reads it). No `gh`, or `gh` failing = no PR info and no "merged" label, never an error. |
| F10 | **Existing seams to reuse:** folder tasks (`Task.folderPath`, binding `inPlace: true`, what chat mode creates for a repository's primary checkout); `claimSessionLaunch` resumes a binding's `sessionId`/`sessionPath` and forks `forkFromSessionPath`; `addLocation` registers a repository; the worktree-removal / branch-deletion call sites in `manager/core-manager.ts` (`toDone`'s forced cleanup, `runForcedCleanupAttempt`, `retryDoneCleanups`, `deleteTask`, rule landing, review-checkout reaping, launch rollback). |
| F11 | **`/totask` history:** it was pi-home's in-session Pi extension command (adopt the current session as a task). Release wave A (R16, decision #18) deleted every extension command because the in-session surface became the core tool catalog; it never existed in Harbormaster's code. Lesson kept: import is a core command, the CLI/MCP and UI are thin clients, nothing lives in the Pi extension. |
| F12 | **Volume on a heavy user's Mac:** ~1,340 Pi session dirs (561 files touched in 30 days), 71 Claude projects, 214 Cursor chats, multi-MB files. Readers must filter by mtime before opening, stream lines, `JSON.parse` only lines that can matter (substring pre-check), and cache per `(path, mtime, size)`. |
| F13 | **State compatibility:** binding and task files keep unknown fields on load (records are validated, not rebuilt), so the new optional `external` / `imported` fields round-trip through older versions. Only a downgrade on the same state dir after importing could ignore `external`; no release note needed. |

## Architecture

Layering as in `docs/design-decisions.md` "Layering"; contracts in
`packages/core/src/contracts/import.ts` (already on this branch).

```
UI (wizard step, Import dialog, inbox item, Remove worktree…)   CLI/MCP (harbormaster import …)
            \                                                     /
             core commands: listImportCandidates · importItems · undoImport · removeExternalWorktree
                         manager/import-runtime.ts (sequence)
                 engines/import.ts (pure: group, dedupe, title, filters, preselect, left-out)
   access/import-*.ts readers (pi, claude-code, codex, cursor, herdr) · access/agent-process-access.ts · git / gh access
```

- **Access (one reader per source)** implements `ImportSourceReader`
  (`read({ since })` → `ImportSessionRecord[]` + `ImportOrchestratorRecord[]`,
  never throws for a missing store; an unknown format version → `error`).
  Roots are constructor options defaulting to the env/home rules in F1-F7,
  so tests and e2e point them at fixture copies. Files:
  `access/import-pi-sessions-access.ts`, `import-claude-sessions-access.ts`,
  `import-codex-sessions-access.ts`, `import-cursor-chats-access.ts`,
  `import-herdr-access.ts` (spawns `herdr` only for `session list --json`
  and `api snapshot`, with a short timeout; a missing binary = no live data).
  `access/agent-process-access.ts` implements `ImportProcessAccess`
  (`ps` + one batched `lsof`, plus Claude's registry; injectable).
  Git facts (common dir, current branch, folder exists) go through
  `GitRepositoryAccess` / `LocalFolderAccess` verbs; PRs through
  `GithubPrAccess.statusMany`.
- **Engine** (`engines/import.ts`, pure): canonicalize cwds, merge records
  into one candidate per folder (orchestrator records join on cwd and on
  session id/path), classify `kind`, attach running info (I3, I13: conservative, every same-harness session in the folder), dedupe
  against the board (any binding's `worktreePath` / `sessionId` /
  `sessionPath` / `previousSessionPath`, any folder task's `folderPath`,
  archived included), hide (`tiny`, `folder-missing`, `not-a-project`,
  `harbormaster-leftover`), title (I7), preselect, group, sort, and count
  what was left out. Unit-tested on its own.
- **Manager** (`manager/import-runtime.ts`, wired from `CoreManager` like the
  other runtimes): reads all sources concurrently, runs the engine, and for
  `importItems` re-lists (state may have moved), validates each selection,
  then creates each task through the same internal path `createTask` uses,
  never a parallel one.
- **Commands** (added to `CoreCommands`, transportable):
  - `listImportCandidates(input?: ListImportCandidatesInput): Promise<ImportCandidateListing>`
  - `importItems(input: ImportItemsInput): Promise<ImportItemsResult>`
  - `undoImport(batchId: string): Promise<UndoImportResult>`
  - `removeExternalWorktree(taskId: string, options?: ToDoneOptions): Promise<ToDoneResult>`
    (same question/confirm protocol as `toDone`: without `force.confirmed`
    it returns the confirmation lines and changes nothing).
- **Frontends:** the app (IPC → core commands, preload `api.ts`) and the
  `harbormaster` CLI/MCP (tool catalog → socket → the same commands). No
  frontend reads an agent store or the process table.

### What an imported task is

| Item kind | Task | Binding |
|---|---|---|
| `worktree` | `repositoryId` (registered if unknown, I16), `branch` = current branch, `harness` = picked session's harness, `title`, `initialPrompt: ""` with `initialPromptDeliveredAt` set (nothing to send), `state: "working"`, `startedAt`, `imported: {batchId, at, sources}` | `worktreePath` = the folder, `branch`, `external: true`, `sessionId` + `sessionPath` of the picked session (first launch = **resume**); with Fork instead: a fresh preassigned `sessionId` and `forkFromSessionPath` (first launch = **fork**) |
| `checkout`, `folder` | folder task: `folderPath` = the folder, no `repositoryId` (as chat mode does) | `inPlace: true`, same session fields; never `external` (a folder task is never removable anyway) |

The task's model stays unset (the session keeps its own). No pane opens and
nothing is launched by the import: the session resumes when the user opens
the task. The rules then place the task (I6) on the next tick exactly as
for any task (the PR is linked by the normal refresh).

### External ownership (I9), enforced in core

- Every worktree-removal and branch-deletion path in the manager (F10) goes
  through ONE guard (e.g. `engines/cleanup.ts` `mayRemoveWorktree(binding)`
  / `mayDeleteBranch(binding)`), so a new call site cannot forget it.
- Done on an External task: the question's lines are only "The worktree
  <path> isn't Harbormaster's and will be kept." (+ "Its terminal pane will
  be closed." when true; never "will be removed", "changes will be
  discarded" or "branch … deleted"). Confirmed: the app ends the task's warm
  session and ptys as for any Done; core records the cleanup as completed
  without touching the folder or the branch, and keeps the path for
  Remove worktree… and Reopen (I14). The refresh sweep never retries it.
- Archive, the 7-day sweep, rule landing (`move: done`) and `deleteTask` /
  `undoImport`: same, never removal.
- `removeExternalWorktree` (I15): Done/archived External tasks with a
  folder still on disk; lines "The worktree <path> will be removed.", "N
  uncommitted changes will be discarded." when true, "The branch <name> is
  kept."; confirmed = force-remove the worktree (same `removeWorktreeForced`
  orphan/missing handling as Done), clear `external`, park the binding,
  audit-log it. Refused (clear error) for a non-External or folder task.
- The orphan scan never lists an External folder (it is bound).

### Undo (I10)

`undoImport(batchId)`: for each task with `imported.batchId === batchId`:
untouched (`imported.touchedAt` unset) → delete the task and its binding
(no folder, branch or session touched; a fork that never launched never
existed); touched → keep and list it. `touchedAt` is set by the first
`claimSessionLaunch` after the import and by user commands that change the
task (move/start/await/done/archive/reopen, title edit, set parent); never
by a rule. The inbox item resolves itself after undo; undoing twice is a
no-op that returns an empty result.

### Inbox summary (I10)

One persisted inbox item per batch (kind `import`, source `harbormaster`,
Other tab), title "Imported N tasks from <sources>" (+ " · M left out
(<reason>: n, …)"), body listing left-out items by reason, buttons
**Show on board** (new action `showBoard`, `with: {taskIds}`: the app opens
the board and highlights them; it does NOT resolve the item, so Undo stays
one click away) and **Undo import** (new action
`undoImport`, `with: {batchId}`; resolves the item with the undo result).
Frontends render buttons from the item, never by kind name.

### Performance

`listImportCandidates` must stay under ~2 s cold and ~0.5 s warm on the
volumes in F12, and must never run on the pty data path. Readers stat
first (skip files older than `since`), stream, pre-filter lines by
substring before `JSON.parse`, and keep a per-file cache keyed by
`(path, mtime, size)` inside the access service. Git and `gh` calls are
batched per repository and bounded in concurrency.

## UI

- **Wizard step** "Bring in your recent work?", after the GitHub step (PR
  titles and labels need `gh`) and before the concepts step. It renders the
  same `ImportList` component as the dialog (docs/settings.md S3 pattern),
  plus the line "Your Claude Code / Codex setup works as-is." Primary
  button "Import N tasks", secondary "Skip"; nothing found = "No recent
  sessions found" and Continue.
- **Import… dialog** from the "+ New" menu and a Settings → General row
  ("Import existing work…"). Rows grouped by repository (header with
  select-all and count), newest first: checkbox, agent icon(s), editable
  title with the grey source hint, branch, last active, labels (`merged`,
  `closed`, `already in Harbormaster`), "+N other sessions" opening the
  session picker. Disabled running rows show the reason, **Check again**
  (re-lists) and **Fork instead** when `canFork`. Footer toggles "Show
  older" and "Show hidden (n)", and the Import button. Keyboard: Space
  toggles a row, Enter imports.
- **Inbox:** the summary item with its two buttons.
- **Task actions:** **Remove worktree…** on Done/archived External tasks,
  through the existing confirm host; Done's question shows the External
  line (computed by core).

## CLI / MCP

Tools in the core catalog (`core/src/tools/catalog.ts`), so the CLI and
MCP faces come for free:

- `harbormaster import list [--older] [--hidden] [--json]`: grouped
  candidates, ids, title + source, sessions, why blocked/hidden.
- `harbormaster import apply <candidateId>… [--preselected] [--title <id>=<text>] [--session <id>=<sessionId>] [--fork <id>] [--dry-run]`:
  `--dry-run` prints what would be created and left out.
- `harbormaster import undo <batchId>`.

MCP tool names `harbormaster_import_list` (`includeOlder`, `includeHidden`),
`harbormaster_import_apply` (`candidateIds`, `preselected`, `titles`
and `sessions` as candidateId → value maps, `forks`, `dryRun`,
`includeOlder`) and `harbormaster_import_undo` (`batchId`). They are agent
catalog tools (not human-only ops) because decision I4 asks for MCP too;
their descriptions tell agents to run them only when the user asked. The
dry run is computed from a fresh listing and imports nothing; `apply`
still goes through `importItems`, which re-validates every selection.

## Fixtures and tests

- **Real fixtures only.** `scripts/record-import-fixtures.mjs` runs each
  real CLI (as `scripts/record-harness-status.mjs` does: a pty, the
  adapter's own launch spec, a temp git repo with a linked worktree) for a
  few short prompts (≥ 3, so the item is not tiny), then **copies** the
  session files it produced into
  `packages/core/tests/fixtures/import/<harness>/<version>/`, rewriting
  absolute paths to placeholders (`__ROOT__`, `__HOME__`), redacting
  account ids/emails, and **deletes** what it created from the user's real
  stores. Codex thread names and Claude/Cursor titles are produced by the
  real CLI (`/rename`, the AI title), not typed into a file. herdr: record
  a real `session.json` (v3) and `herdr api snapshot` from herdr 0.9.5 with
  a temp `XDG_CONFIG_HOME`.
- **Unit tests:** every reader against its fixtures (titles, cwd,
  timestamps, prompt counts, internal sessions excluded); the engine
  (grouping, dedupe, titles, hidden reasons, preselect, running/fork,
  left-out counts); the process access (parsing recorded `ps`/`lsof`
  output, Claude registry staleness); manager integration for
  `importItems` / `undoImport` / `removeExternalWorktree` and External
  through **every** cleanup path (Done, Archive, 7-day sweep, rule landing,
  retry sweep, delete), each shown to fail with the guard removed.
- **e2e (lean):** one `e2e/import.spec.ts`: fixture stores (temp copies)
  + a fake process access → "+ New" → Import… → tick, edit a title, pick a
  session → Import → tasks on the board → inbox summary → Undo removes
  them. The onboarding step gets one assertion in `onboarding.spec.ts`
  (wizard shows the step and imports one item). Offscreen, fake clipboard,
  readers pointed at fixtures through env (never the user's real stores),
  each new e2e proven to fail with the feature reverted.

## Delivery

One feature branch, one draft PR (this owner task). Child tasks implement
and push to their own branches off this one; they never open PRs. The
owner reviews and merges each into this branch.

| Child | Scope | Depends on |
|---|---|---|
| a. core | four agent readers + fixtures + recorder, process access, engine, manager + commands, External ownership in every cleanup path, Done/Remove-worktree lines, undo, inbox item + button actions | contracts (on this branch) |
| b. herdr | herdr reader + recorded fixtures | contracts; wires into (a)'s reader list on merge |
| c. CLI/MCP | catalog tools + CLI/MCP output + tests | (a) merged |
| d. UI | wizard step, Import dialog, inbox actions, Remove worktree…, Done line, e2e | (a) merged |

## Out of scope

Per-task session-history panel, multi-session tasks, Conductor / Orca /
Superset readers, the herdr desktop app, automatic import, and importing
skills, MCP servers, settings or setup scripts.
