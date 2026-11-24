# Harbormaster: design decision record

Product re-platforming of pi-home (Pi extension + terminal-multiplexer workflow) into a
standalone desktop app. Decisions reached in a grilled design interview,
2026-10-05. Amend this file when a decision is revisited; do not silently
diverge.

## Why leave the terminal multiplexer

The board and the sessions lived in two different programs, so neither could
control the other:

- Multiplexer pane metadata (branch/path/PR) is launch-time state; pi-home cannot
  update it when a pane is reused for a different task.
- "Click a card → open in a side pane, or focus the existing one" is
  impossible when the board is a TUI inside one pane and the window manager is
  someone else (open workspace → open pi-home → select task, every time).
- Live status (spinner while an agent runs, PR badge, stage badge) needs a
  reactive UI fed by core state, not a terminal repainting every 30s.

**Root constraint: the board must own the session panes' lifecycle.**

## Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Audience | Personal tool now, open-source product someday. Core headless; UIs are replaceable frontends. |
| 2 | Session surface | Hybrid, structured-primary ambition: pretty UI where possible, real terminal where needed. v1 session panes are Pi TUIs in ptys (full extension fidelity, no feature race with the Pi TUI). |
| 3 | Platform | Desktop (macOS first) now. Remote-daemon someday → core API transportable; no daemon yet. Mobile/web: non-goals. |
| 4 | Ownership | Build and own it. No waiting on upstream maintainers. pi-gui (MIT) is a parts bin (terminal wiring, later the structured timeline), never a base. |
| 5 | Brain placement | Core extracted into `packages/core` behind a command API (commands in, state events out), hosted inside the app process. The boundary becomes the daemon API later. |
| 6 | Extension ↔ app | Shared core library over the per-user state dir; all writes through the command API; no frontend touches state files. Movers tick only in the app. |
| 7 | TUI board | Frozen, not killed: emergency/SSH fallback compiled against the core API. New board features are app-only. |
| 8 | Attachment | Takeover-offer semantics (verified: Pi has no concurrent-attachment protection, append-only JSONL, no locking). `openGuarded` ports from pi-home; the multiplexer branch becomes "focus the app pane". |
| 9 | Stack | Electron + Vite + React + TS (no Next.js, no router). Verified as the stack coding agents generate most reliably in 2026. |
| 10 | Design system | Tailwind + shadcn/ui (copy-in ownership), dnd-kit for the board (Kibo UI / Georgegriff shadcn kanban as starting blocks; astryx templates as layout reference: Kanban Board, IDE, Work Item Detail, Side Nav). Re-skin anything lifted from pi-gui. |
| 11 | Layout engine | dockview: tabs and splits are one panel model. Three top-level views: workspace (task sidebar + per-task dockview terminal workspaces, the default), kanban board (the "home" triage screen, in place of the task workspace with the sidebar staying, reached via sidebar button / Cmd+Shift+B, either one again or Esc going back; clicking a card enters the task's workspace), and the inbox (sidebar stays, the main area lists everything that needs a human; sidebar button / Cmd+I, Esc back; see docs/release-plan.md "Inbox"). Cmd+B (or the sidebar's hide button) hides the sidebar entirely, as in most macOS apps; each main-area header then shows a Show sidebar button. Per-task dockview instances persist across view switches. Drag/split → extra `$SHELL` pty in the same worktree. Built-in layout serialization for restore-on-restart. |
| 12 | Terminals | @xterm/xterm + node-pty (lift pi-gui's `terminal-service.ts` wiring). Pane↔process lifecycle glue is ours. |
| 13 | Multi-agent future | Harness adapter interface in core (spawn / attach / presence / running-detection). Pi is the only adapter v1. |
| 14 | Name | Harbormaster (npm free, no serious collisions). Private repo `finete/harbormaster`, default branch `main`, monorepo. |
| 15 | Internal architecture | Volatility-based layering (Manager / Engine / Resource Access / Utility), carried over from pi-home's `src/` layout. See "Layering" below. Accessor separation and call-chain direction are hard rules; "all rules in Engines" is advisory. |
| 16 | Workflow verbs | Exactly three invariant verbs — **toworking / toawait / todone** (+ **reopen** for Done work). See "Three verbs, awaiting kinds are data" below. |
| 17 | Terminal renderer | xterm's DOM renderer only; no `@xterm/addon-webgl`. See "Terminal renderer: DOM" below. |
| 18 | Release re-platforming (2026-11-11) | See `docs/release-plan.md`. Supersedes #13's "extension-driven presence" and the mover engine: agent status via OSC 7501 parsed by the pty owner; one core tool catalog exposed as MCP + `harbormaster` CLI over a local socket; per-agent glue is inbox delivery only; board automation is an event → condition → action rules engine (CloudEvents + CEL + YAML, addon sources); one inbox for everything needing a human; TUI board and pi-home migration deleted. |
| 19 | Column names | The second column is **Working** (`working`), not Dev; rules `move` targets equal the state ids (`working \| awaiting \| done`); an agent mid-turn is **running**, never "working". See "Column names: Working, and running agents" below. |

## Layering

Decompose by what could change (volatility), not by the order of use-case
steps. Four service types, `packages/core/src/` folders in parentheses:

| Type | Encapsulates | Rules |
|---|---|---|
| **Manager** (`manager/`) | The sequence of a use case / workflow | Coordinates Engines and Access; changes when the workflow changes. Avoid Manager → Manager calls. |
| **Engine** (`engines/`) | Business rules | Stateless, pure, shareable; changes when rules change. |
| **Resource Access** (`access/`) | Where/how data lives (state files, git, GitHub, harness sessions, ptys) | Atomic business verbs, not CRUD. The only layer that touches a resource. |
| **Utility** (`utilities/`) | Cross-cutting infrastructure (locks, atomic JSON, event bus, clocks) | Callable from any layer. |

Call direction is strictly Client → Manager → Engine → Access → Resource
(Utilities from anywhere, never upward, no layer bypassing; frontends never
call Access). **Hard rules:** accessor separation and call direction.
**Advisory:** small rule sets may live in their Manager until they are shared
or volatile enough to deserve an Engine. Contracts (`contracts/`) are plain
types at the boundaries.

## Launching tasks from an agent

One core command, `launchTask`, creates a task and queues it to start in
the background. `relation` is required with no default (guessing went wrong
in Orca): `child` (nested under the launcher, pollable with
`harbormaster_subtask_status`, Done-with-active-tasks-below confirmation;
trees nest up to `launch.maxNestingDepth` levels, default 3, see
`docs/task-trees.md`) or `standalone` (display-only `launchedFromTaskId`
provenance). Every launch gets its own task, worktree, branch, and session;
a same-repository child may opt into `baseBranch: "parent"` (stacked
work). Lineage is not fixed at launch: `setTaskParent` nests an existing
task under another (or un-nests it) with its whole subtree, refused only
past the max nesting depth or into its own subtree (`docs/task-trees.md`
decision 10), as lineage only (branch, worktree, and session stay put); the rail's row
context menu drives it ("Make child of…" / "Remove from parent"). `mode` mirrors the composer's Task / Review / Chat switch: `review`
binds the launch to an existing PR (`pullRequest` + `role`, worktree on the
PR head; a reviewer's kickoff forbids commit/push/PR), `chat` runs in place
with no worktree (`inPlace`). Launched tasks run as ordinary interactive Pi sessions in app-owned
ptys; once a launch's pty actually starts, main pushes `app:task-launched`
and the renderer adds it to the sidebar rail (its pane attaches, never
takes over) without stealing focus or the view; a message wake is not a
launch and never adds a row. `launch.maxConcurrent`
(default 6) counts only *running* launches; quitting the app stops
everything and marks mid-turn launches `interrupted` (no auto-resume;
queued launches start when the app comes up). Board columns stay with the
movers: agents never move their own card. A kickoff contract
(`engines/launch-kickoff.ts`) is appended to every launch prompt: work only
in the worktree, run checks, commit + push + draft PR (repository tasks),
ask only when genuinely blocked, and finish with
`harbormaster_report_status`, which records an `outcome` on the still-live
presence record (the task shows "your move", not ended) and, for a task with
a parent, tells the parent over the normal child-to-parent route. Tasks can message
each other: see `docs/task-messaging.md`.

## Three verbs, awaiting kinds are data

The workflow surface (commands, buttons, keys, IPC names) has exactly three
invariant verbs — **toworking** (`startTask` / `moveTask(…, "working")`),
**toawait** (`toAwait(taskId, kindId, options)`), **todone** (`toDone`) —
plus **reopen** (`reopenTask`) for Done work. *Why* a task is awaiting is
not a verb: it is an **awaiting kind**, a record in core's registry
(`engines/awaiting-kinds.ts`: id, label, optional input fields, optional
`onEnter` action) that the one toawait verb is parameterized with. Kinds
are built-in data today and shaped so configured kinds can slot in later
without new commands; rules already consume kinds purely as data.

- **Review is a built-in default kind, not a verb.** Its `onEnter` pushes
  the branch and opens or reuses the PR (the former `toReview` body) for a
  repository-backed task; a repository-less task simply waits. Pickers
  preselect it, so the board's `r` (Await… picker, review preselected) +
  Enter keeps the old muscle memory without hardwiring a kind.
- **Slack** takes an optional permalink input and has no action.
- **Deploy** requires a PR: its `onEnter` squash-merges a still-open PR
  (`GithubPrAccess.squashMerge`, `gh pr merge <n> --squash`), then the task
  enters the repository's first deployment stage — or the stage-less
  `__production` wait when it has no pipeline. pi-home's `/towaitprod`
  merge behavior lives here now.
- Frontends render the registry (`listAwaitingKinds`: labels, inputs,
  per-task availability and side-effect notices) and never branch on kind
  names for controls. Kind-specific *display* (group headings, state chips)
  is fine. Board cards carry no workflow buttons: the verbs live in the
  workspace header, the board keys, and drag-and-drop. The one button on a
  card is its hover × (Archive, which asks first).

## Column names: Working, and running agents

The column between Backlog and Awaiting was `dev`. That is too
code-specific for a board that also holds research, writing and reviewing
someone else's PR; it is now **`working` / "Working"**: the ball is in our
(or our agent's) court, and it pairs with Awaiting (someone else's court).

- **One vocabulary for columns.** `TaskState` is
  `backlog | working | awaiting | done`, and a rule's `move` target is the
  same id it compares in CEL: `to: working | awaiting | done`. The old
  `to: await` target (the one name that differed from its state) is gone.
  The `toAwait` command and the Await… picker keep their verb name: the
  verb is "await", the column it lands in is `awaiting`.
- **"Working" is the column; an agent mid-turn is "running".** Our own
  run-state vocabulary (`TaskRunState`, `ChildRunState`, the presence
  activity, `isRunning` in the background launcher, `launch.maxConcurrent`
  counting *running* launches, the yellow `status-running` token) says
  `running`, so "a Working task whose agent is not running" is never
  ambiguous. OSC 7501's own `state=working` is an external protocol value
  and stays as-is at the parser boundary.
- **Clean break, no aliases.** With a single user at the time, there is no
  compatibility code: `dev` and `await` are rejected everywhere (task-state
  validation, the rules schema, the API). CEL compares plain strings, so a
  leftover `task.state == "dev"` would fail silently by never matching; the
  rules loader rejects a `.state` compared with `"dev"` or `"await"` with a
  pointer to the new name.
- **History is not rewritten.** Audit-log entries written before the
  rename keep their raw `dev` / `await` and read as "Dev" / "Await".
- **Legacy-mover fixtures keep pi-home's words.** `tests/fixtures/
  legacy-movers/` is a verbatim oracle for the rules parity test; it keeps
  `dev` and translates only at its two boundaries.

## Verified facts the design rests on

- Pi RPC mode implements an extension-UI subprotocol: dialogs
  (`select`/`confirm`/`input`/`editor`) request/response, fire-and-forget
  (`notify`/`setStatus`/`setWidget`/`setTitle`); `custom()` and
  footer/header/editor overrides are TUI-only (`docs/rpc-extension-ui.md`).
- pi-home used `ctx.ui.custom()` in exactly one place (the kanban board
  component), which is replaced by the native board. All other ~70 call sites
  are dialog/notify/status/widget calls that survive outside the TUI.
- pi-gui (minghinmatthewlam/pi-gui, MIT, ~64k LOC) fully renders the dialog
  subprotocol natively, flags terminal-only capabilities gracefully, drives
  sessions through `@earendil-works/pi-coding-agent` with Pi's JSONL session
  files as source of truth, and ships node-pty/xterm terminal wiring. Fast-
  moving solo project → parts bin, not dependency.
- Paseo bridges Pi dialogs into question permissions but intentionally ignores
  fire-and-forget UI; Pi is one provider among many. Not chosen.
- Pi sessions have no concurrent-attachment protection; pi-home's presence
  system exists because of that, and its semantics carry over.
- shadcn/ui + Tailwind is the dominant 2026 React stack and the default
  output of AI UI generators; shadcn kanban blocks exist (dnd-kit-based).

## Terminal renderer: DOM

Terminal panes use xterm's DOM renderer, never WebGL (decision #17).

- **Why.** After macOS sleep or screen lock the WebGL renderer drew nothing
  for minutes: inspected live on macOS 26.5 / Electron 33, the buffer was
  intact, frames were flowing, and even a brand-new WebGL addon on a fresh
  context painted a blank pane, while the DOM renderer painted the same
  terminal at once. This is an open problem across xterm.js embedders
  (VS Code #311614, Wave #2895; everyone's reliable workaround is "GPU
  acceleration off"). WebGL also needed a growing stack of workarounds:
  per-pane context parking (Chromium's live-context cap and GPU memory), a
  context-loss fallback, wake-time resets, and addon-webgl 0.19's shared
  glyph-atlas corruption (xterm.js #6014, fixed only in 0.20 beta).
- **Cost, measured.** With the perf-flood harness (synthetic ~20 MB/s ANSI
  flood): one flooding pane drains ~18 MB/s on DOM vs ~26 MB/s on WebGL
  with the same frame rate, hover latency (p95 ~19 ms) and renderer CPU;
  two panes flooding side by side drop DOM to ~60 fps (frame-gap p95
  16.7 ms vs 9 ms) with hover p95 ~25 ms vs ~21 ms and no long tasks.
  Real agent output is orders of magnitude below that. Glyphs (box
  drawing, blocks, braille, Powerline, attributes) render the same; DOM
  cells are marginally wider (xterm.js #6015), so a pane fits ~1-2% fewer
  columns.
- **Revisit when** addon-webgl ships the 0.20 atlas fixes as stable *and*
  there's evidence the post-wake blank is fixed upstream; re-measure with
  perf-flood before switching.
- **Breadcrumbs.** `<userData>/logs/wake.log` records power / lock events,
  renderer and GPU process exits, and renderer console errors, so the next
  display incident after sleep leaves evidence.

## v1 scope (switch-your-daily-driver bar)

Board with live badges (presence spinner, PR number+state, stage label) ·
click→open/focus pty pane in the right worktree · split shell pane per task ·
takeover-offer flow · task creation + todev/toawait/todone as buttons · movers
ticking in-app.

**Out of v1:** diff viewer, structured timeline, notifications, themes,
cross-task split layouts, daemon, non-Pi adapters.

## Migration order

1. Port pi-home's core (manager/engines/access layers) into `packages/core`
   behind the command API; the frozen TUI in `packages/extension` is its first
   client (pure refactor, value-neutral).
2. Electron shell: board + pty panes on that API.
3. Run alongside the multiplexer/pi-home setup until trusted.
4. Delete the multiplexer integration (the presence location field,
   focus-pane branch, multiplexer env capture) and retire the old pi-home repo to frozen-extension status.

## Blessed divergences from pi-home

Deliberate differences from pi-home's behavior, confirmed in the
behavioral-parity audit. Everything else is meant to match pi-home; a
difference not listed here is a bug.

- **Always push before `ensureOpen`.** The review kind's onEnter pushes the task branch
  every time before reusing or opening the PR (pi-home pushed only when
  creating one), so a reused PR always shows the latest local commits.
- **The auto path never force-deletes.** A mover-proposed landing (after the
  last deployment stage) never asks and never forces: if cleanup would be
  refused (dirty worktree, open in a live pane, ...) the task stays in
  Awaiting with a "deployed and ready to land — mark it Done" warning.
- **Manual Done is final; the worktree housekeeping is the app's.** Done
  (button, `x`, a drop on Done, an inbox action) asks ONE small question,
  "Mark done?", whose lines core computes up front: "The worktree <path>
  will be removed.", and only when true "N uncommitted changes will be
  discarded.", "Branch <name> is not merged; the local branch will be
  deleted.", "Its terminal pane will be closed." (a task without a worktree
  gets just "Mark done?"). Cancel / Mark done (Enter); never a second
  question. (A parent with active children is still asked about them
  first: that one is about other tasks.) Once confirmed the task moves to
  Done immediately and records `task.cleanup` (`mode: "forced"`): the app
  ends the task's warm session and every pty in the worktree (closing its
  panes), then core force-removes the worktree, parks the binding (session
  identity survives a reopen), removes review checkouts and deletes the
  local branch. A failure never blocks the move and is never a toast: it
  is recorded on the task (`attempts`, `lastError`, audit log) and the
  refresh sweep retries silently with force (1 min, 5 min, 30 min, then
  hourly). Orphans are handled without asking: a folder whose git metadata
  is gone is deleted and pruned, metadata without a folder is pruned, a
  missing folder counts as cleaned. After 3 failed attempts one Other-tab
  inbox item per task ("Couldn't clean up <task>'s worktree: <reason>":
  Retry, Open folder, Dismiss = give up, `mode: "abandoned"`) is the only
  thing the user ever sees about it. pi-home asked "Discard uncommitted
  changes?" / "Delete unmerged task workspace?" one after the other and
  kept a live pane's worktree with a warning.
- **Archive is Done, then off the board.** `archiveTask` (workspace header
  Archive, a card's hover ×, `e` on the board, the rail row's menu) is not
  a fourth verb. It always asks once ("Archive?"): a Done task's question
  has no other lines and it gets `archivedAt`; any other task gets the Done
  question's lines and lands in Done already archived, in one write, so
  nothing keeps running unseen. Archived tasks are listed behind the Done
  column's "show archived" (`a`) and in the rail's collapsible "Archived"
  section under the tasks (newest first, ten at a time behind "Show more";
  never as a task row). Whenever a task becomes archived (here, in another
  window, or by the 7-day sweep, which archives old Done tasks the same
  way) its open workspace closes (the user's own close, so a live review
  still asks about unsent comments). Archiving a task already Done ends
  nothing in its worktree; its Done cleanup already ran or keeps retrying.
  Reopen (or any move out of Done) clears the flag.
- **Every Done task is resumable; opening one never resumes it by
  itself.** A Done task has nothing to run in (cleanup removed its
  worktree, or it went Done straight from Backlog), so a Done or archived
  task's workspace (a card or rail row click) shows an empty state with a
  Resume button instead of a pane: no stray plain shell in the app's cwd.
  Resume (focused whenever the workspace comes on screen, so Enter) is
  Reopen without the objective question: back to Working in a
  fresh branch + worktree (a folder task in its folder, a scratch task in
  its scratch directory, which Done only parked) and the workspace's first
  pane forks or resumes the previous conversation. A Done card dropped on
  Working is the same reopen, as Backlog → Working is Start; a bare move
  would leave a Working task with no worktree. A reopen of a task already
  being reopened joins that one, so a repeated drop (or Resume plus the
  header's Reopen) never starts a second cycle. A Done task whose cleanup
  left its worktree in place still opens its agent there.
- **Working → Backlog keeps the worktree.** No parking modes: a task moved back
  to Backlog keeps its branch, worktree, and session as-is.
- **Worktree layout.** Task worktrees live at
  `<stateDir>/worktrees/<repo-folder>/<branch-slug>` (default
  `~/.harbormaster/worktrees/`), and derived branch names end in a
  6-character task-id suffix. One app-owned root for every repository,
  whether it was found under `codeRoot` or added with "Open folder…": the
  old `<parent-of-checkout>/.harbormaster-worktrees/` layout scattered
  worktrees next to registered folders, where the orphan scan (which only
  looked under `codeRoot`) never saw them. Pre-0.1.2 worktrees keep their
  recorded paths, and the orphan scan still covers the legacy folders.
- **New task branches start from the freshest default branch.** When a
  task's base is the repository's default branch (no explicit `baseRef`,
  or a `baseRef` that just names the default branch; not
  `baseBranch: "parent"`, not a PR/review checkout), core first runs
  `git fetch origin <default>` (5 s limit, never prompts: terminal,
  credential-manager and askpass prompts are off) and then starts from the
  newer of local `<default>` and `origin/<default>`: origin when local is a
  strict ancestor of it (people who land work through PRs and never pull
  `main` would otherwise start every task on stale code), local when it is
  equal, ahead or diverged, so unpushed commits are never skipped. No
  `origin`, no local branch, a failed or timed-out fetch: use what exists
  (local, else the cached `origin/<default>`); a fetch never fails a launch.
  The fetch only updates the remote-tracking ref: the user's local
  `<default>` and checked-out tree are never moved. It runs on every launch
  (tasks are often launched right after a PR merges), shared between
  launches racing in one repository. Origin wins as a commit id, so the new
  branch tracks nothing. The base chosen and why is logged per task
  (`[core:launch] task <id> starts from origin base {"base":"origin/main@…","baseReason":"local-behind-origin; fetch ok"}`),
  and the fetch is a timed `worktree.resolve-base` span. Lives in
  `GitWorktreeAccess.resolveDefaultBase` (git I/O) with the pure choice in
  `utilities/default-base.ts`. Matches Conductor (fetch, start from
  origin/<base>) and Claude Code's `worktree.baseRef: "fresh"`, plus the
  unpushed-commits safeguard.
- **`codeRoot` is the repositories folder.** It is scanned for checkouts
  (so agents can launch into repositories never opened in the app) and is
  where clone-by-URL puts new clones; a clone URL whose remote is already
  checked out anywhere known (under `codeRoot` or a registered folder) is
  reused instead. Onboarding suggests the first existing usual code folder
  (`~/Code`, `~/src`, `~/Projects`, …), else `~/harbormaster`: not inside
  `~/.harbormaster`, because clones are the user's long-lived checkouts,
  not app state.
- **Rules evaluate only in the app.** The Electron app is the single automation
  host; the Pi extension never runs rules or refreshes. ("Movers" became the
  rules engine in decision #18; the single-host rule is unchanged.)
- **The in-session surface is the tool catalog.** Decision #18 removed the
  extension's commands, widget and tools; agents reach core only through the
  shared catalog (`harbormaster mcp` / CLI). The Pi extension delivers inbox
  messages and nothing else. Board automation still lives only in the app.
- **Launching replaces pi-home's subtasks and headless runner.** One
  `launchTask` command with an explicit `child` / `standalone` relation
  (`harbormaster_launch_task`, `harbormaster_subtask_status`; the launch tool
  also works outside task sessions, standalone only). Launched tasks run as
  ordinary interactive Pi sessions in app-owned ptys with no pane until
  opened (attach, never takeover); quitting the app stops them, no detached
  processes. See "Launching tasks from an agent" above.
- **Reviewing a PR has its own tool.** Agents pick tools by name and skip
  field descriptions, so a review launched through `launch_task` without
  `pullRequest` became a fresh branch off main with no PR link.
  `review_pull_request(pullRequest, prompt)` is the review entry point, and
  `launch_task` refuses a launch whose title or prompt names a PR but passes
  no `pullRequest` (the refusal names `review_pull_request`; `pullRequest:
  "none"` confirms new work that only mentions a PR). Tool replies are the
  one text agents always read.
- **No long argument on an agent's command line.** A managed Mac's
  endpoint security (SentinelOne, Nov 2026) SIGKILLs any interpreter +
  script launch with a single 943+ char argument, at exec. Initial prompts
  over 400 chars travel as `<stateDir>/prompts/<taskId>.md`
  (`LaunchSpec.promptFile`, written by the launcher); the arguments only
  reference it (Pi and Claude attach it with `@<path>`, others are told to
  read it). The launcher refuses any spec with a 900+ char argument, and
  the contract test holds every adapter to that. The prompt file and
  Cursor's plugin dir are removed when the task's workspace is (Done
  cleanup, delete; `LaunchFilesAccess`); a reopen's launch writes them
  again.
- **Closing a task's tab hides it, it does not stop it.** The task's pi is
  detached back to an app-owned paneless pty (the same path a window reload
  uses), so reopening re-attaches instantly instead of cold-starting pi
  (session resume + MCP reconnect took seconds), and closing never
  interrupts a running agent. Bounded: only the 6 most recently closed stay
  warm; older idle ones are killed (that reopen cold-starts as before), and a
  mid-turn agent is never evicted. A warm session ends when its task goes to
  Done or is deleted, so it never blocks worktree cleanup. "+ terminal"
  shells still die with their tab. See `packages/app/src/main/warm-sessions.ts`.
- **Tasks can steer tasks.** Which task → task sends deliver directly is the
  user's setting `messaging.directRoutes` (parent and child; the same task
  tree, the default; or any task), plus per-pair grants ("Approve and allow
  both ways"). Direct pairs are loop-capped; child questions to the direct
  parent show "waiting on parent". Everything else, and every non-task
  sender, needs the user's approval in the app. Delivery is a
  harness-adapter concern behind a core message log. See
  `docs/task-messaging.md` and `docs/task-trees.md`.
- **The sidebar rail order is fixed and user-owned.** Nothing reorders rows
  except an explicit drag: no activity sort, no board-column order, no
  reaction to presence or core pushes. Rows keep one persisted global task
  order (`harbormaster.sidebar.taskOrder`); a newly opened task lands at the
  bottom of its section and closing forgets the position. Rows are sortable
  (`@dnd-kit/sortable`) within their own section only (a repo group or
  Pinned; never across), repo groups reorder by their header
  (`harbormaster.sidebar.groupOrder`), and a nested child dragged out of its
  parent's block detaches into a top-level row with the "↳ parent" line
  (`harbormaster.sidebar.detachedChildIds`) until it is dragged back. The
  order is committed once, on drop.
- **Lineage wins over repo within a column.** Trees nest several levels
  (`docs/task-trees.md` decision 11): one indent per level (max 4 levels),
  each parent collapsing on its own, and every rule below applies per
  parent link. On the board, a child nests
  under its parent whenever both are in the same column (in Awaiting: the
  same awaiting kind), whatever their repositories; on the rail, whenever
  both are open (and neither is pinned). The parent's repo group hosts the
  family, and a group's count is the rows shown under its header. A child
  whose parent is in another column (or, on the rail, not open, pinned, or
  hidden by the search) keeps its own repo group with a "↳ parent" line.
  Core still groups columns purely by repository
  (`engines/board-grouping.ts`); the renderer applies the lineage move
  (`lib/task-lineage.ts`). Every card and rail row carries a quiet mono repo
  chip (short repo name, or "scratch") so a hosted cross-repo child still
  shows where it lives.
