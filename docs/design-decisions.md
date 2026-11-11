# Harbormaster: design decision record

Product re-platforming of pi-home (Pi extension + cmux workflow) into a
standalone desktop app. Decisions reached in a grilled design interview,
2026-10-05. Amend this file when a decision is revisited; do not silently
diverge.

## Why leave cmux

The board and the sessions lived in two different programs, so neither could
control the other:

- cmux pane metadata (branch/path/PR) is launch-time state; pi-home cannot
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
| 8 | Attachment | Takeover-offer semantics (verified: Pi has no concurrent-attachment protection, append-only JSONL, no locking). `openGuarded` ports from pi-home; the cmux branch becomes "focus the app pane". |
| 9 | Stack | Electron + Vite + React + TS (no Next.js, no router). Verified as the stack coding agents generate most reliably in 2026. |
| 10 | Design system | Tailwind + shadcn/ui (copy-in ownership), dnd-kit for the board (Kibo UI / Georgegriff shadcn kanban as starting blocks; astryx templates as layout reference: Kanban Board, IDE, Work Item Detail, Side Nav). Re-skin anything lifted from pi-gui. |
| 11 | Layout engine | dockview: tabs and splits are one panel model. Three top-level views: workspace (task sidebar + per-task dockview terminal workspaces, the default), kanban board (the "home" triage screen, full-width, reached via sidebar button / Cmd+B; clicking a card enters the task's workspace), and the inbox (sidebar stays, the main area lists everything that needs a human; sidebar button / Cmd+I, Esc back; see docs/release-plan.md "Inbox"). Per-task dockview instances persist across view switches. Drag/split → extra `$SHELL` pty in the same worktree. Built-in layout serialization for restore-on-restart. |
| 12 | Terminals | @xterm/xterm + node-pty (lift pi-gui's `terminal-service.ts` wiring). Pane↔process lifecycle glue is ours. |
| 13 | Multi-agent future | Harness adapter interface in core (spawn / attach / presence / running-detection). Pi is the only adapter v1. |
| 14 | Name | Harbormaster (npm free, no serious collisions). Private repo `finete/harbormaster`, default branch `main`, monorepo. |
| 15 | Internal architecture | Volatility-based layering (Manager / Engine / Resource Access / Utility), carried over from pi-home's `src/` layout. See "Layering" below. Accessor separation and call-chain direction are hard rules; "all rules in Engines" is advisory. |
| 16 | Workflow verbs | Exactly three invariant verbs — **todev / toawait / todone** (+ **reopen** for Done work). See "Three verbs, awaiting kinds are data" below. |
| 17 | Terminal renderer | xterm's DOM renderer only; no `@xterm/addon-webgl`. See "Terminal renderer: DOM" below. |
| 18 | Release re-platforming (2026-11-11) | See `docs/release-plan.md`. Supersedes #13's "extension-driven presence" and the mover engine: agent status via OSC 7501 parsed by the pty owner; one core tool catalog exposed as MCP + `harbormaster` CLI over a local socket; per-agent glue is inbox delivery only; board automation is an event → condition → action rules engine (CloudEvents + CEL + YAML, addon sources); one inbox for everything needing a human; TUI board and pi-home migration deleted. |

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
`harbormaster_subtask_status`, Done-with-active-children confirmation; one
level only) or `standalone` (display-only `launchedFromTaskId`
provenance). Every launch gets its own task, worktree, branch, and session;
a same-repository child may opt into `baseBranch: "parent"` (stacked
work). Launched tasks run as ordinary interactive Pi sessions in app-owned
ptys; once a launch's pty actually starts, main pushes `app:task-launched`
and the renderer adds it to the sidebar rail (its pane attaches, never
takes over) without stealing focus or the view; a message wake is not a
launch and never adds a row. `launch.maxConcurrent`
(default 6) counts only *working* launches; quitting the app stops
everything and marks mid-turn launches `interrupted` (no auto-resume;
queued launches start when the app comes up). Board columns stay with the
movers: agents never move their own card. A kickoff contract
(`engines/launch-kickoff.ts`) is appended to every launch prompt: work only
in the worktree, run checks, commit + push + draft PR (repository tasks),
ask only when genuinely blocked, and finish with
`harbormaster_report_status`, which records an `outcome` on the still-live
presence record (the task shows "your move", not ended). Tasks can message
each other: see `docs/task-messaging.md`.

## Three verbs, awaiting kinds are data

The workflow surface (commands, buttons, keys, IPC names) has exactly three
invariant verbs — **todev** (`startTask` / `moveTask(…, "dev")`),
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
  is fine. Board cards carry no action buttons: the verbs live in the
  workspace header, the board keys, and drag-and-drop.

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
3. Run alongside cmux/pi-home until trusted.
4. Delete the cmux integration (`record.cmux`, focus-pane branch, `CMUX_*`
   capture) and retire the old pi-home repo to frozen-extension status.

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
  Manual Done matches pi-home: it asks "Discard uncommitted changes?" /
  "Delete unmerged task workspace?" before destroying work, and keeps a
  live pane's worktree without asking (cleaned up by a later refresh).
- **Dev → Backlog keeps the worktree.** No parking modes: a task moved back
  to Backlog keeps its branch, worktree, and session as-is.
- **Worktree layout.** Task worktrees live at
  `<codeRoot>/.harbormaster-worktrees/<branch-slug>`, and derived branch
  names end in a 6-character task-id suffix.
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
- **Closing a task's tab hides it, it does not stop it.** The task's pi is
  detached back to an app-owned paneless pty (the same path a window reload
  uses), so reopening re-attaches instantly instead of cold-starting pi
  (session resume + MCP reconnect took seconds), and closing never
  interrupts a working agent. Bounded: only the 6 most recently closed stay
  warm; older idle ones are killed (that reopen cold-starts as before), and a
  mid-turn agent is never evicted. A warm session ends when its task goes to
  Done or is deleted, so it never blocks worktree cleanup. "+ terminal"
  shells still die with their tab. See `packages/app/src/main/warm-sessions.ts`.
- **Tasks can steer tasks.** Parent ↔ child messages deliver directly
  (loop-capped, child questions show "waiting on parent"); every other
  cross-task send needs the user's approval in the app. Delivery is a
  harness-adapter concern behind a core message log. See
  `docs/task-messaging.md`.
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
