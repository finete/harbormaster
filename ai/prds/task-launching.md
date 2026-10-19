# Launching tasks from an agent: subtasks and standalone tasks

Status: agreed design (debated against Orca, Claude Code agent view, Amp
agent-to-agent, Vibe Kanban MCP). Replaces pi-home's `/spawnsubtasks`,
`pihome_spawn_subtasks`, `pihome_subtask_status`, and its headless `pi -p`
runner. pi-home is a behavioral reference, not an architecture to copy.

## The one primitive

One core command, `launchTask`, creates a board task **and queues it to start
running immediately in the background**. A required `relation` decides
whether it is linked to the task that launched it:

| relation | lineage | parent can poll it | Done-with-active-children warning | typical use |
|---|---|---|---|---|
| `child` | `parentTaskId` set; nested under the parent on the board | yes | yes | "find the bugs" → one PR per fix; work that belongs to / depends on the current task |
| `standalone` | none; only display-only provenance `launchedFromTaskId` | no | no | "while I'm on arnac, start an agent in repo X for an unrelated thing"; they part ways |

The agent must choose and state the relation explicitly (Orca's lesson: no
default, guessing went wrong). Rule of thumb in the tool description: `child`
only when the work is conceptually part of / depends on the current task;
`standalone` for independent fixes, other repositories, unrelated follow-ups.

Rules:

- **One level only.** A child cannot launch children (`child` from a task that
  itself has `parentTaskId` rejects). It may launch `standalone` tasks.
- `child` requires a launching task. `standalone` may also be launched from a
  Pi session that is not a Harbormaster task (no provenance then).
- **No same-worktree workers** (deferred). Every launched task gets its own
  task, card, worktree, branch, and session, like pi-home.
- **Repository**: a discovered repository id, `"none"` (General / no repo),
  or a clone URL (cloned under `codeRoot`, reused if already present with the
  same remote).
- **Base branch**: the repository's default branch. A `child` in the *same*
  repository as its parent may opt into `baseBranch: "parent"` (stacked work:
  the worktree starts from the parent's branch). The PR still targets the
  default branch; the kickoff tells the agent to state the dependency.
  Never for `standalone`.
- **Model**: optional per launch; falls back to `launch.defaultModel` in the
  global config, else the harness default. Passed to the harness only on the
  first launch of the session.

## Execution: app-owned ptys, no headless runner

There is no separate headless/background process type.

- The app (the single automation host) starts a launched task as a **normal
  interactive Pi session in a pty that no pane is showing yet**, using the
  exact same launch path as a primary pane (`claimSessionLaunch`,
  `claimInitialPrompt`, `buildLaunchSpec`).
- Opening the task in the app **attaches** its primary pane to that already-
  running pty (screen state replayed, then live). No takeover dialog for the
  app's own background ptys. Closing the pane afterwards behaves like any
  primary pane.
- **Quitting the app stops everything.** No detached processes, ever. Tasks
  whose background session was mid-turn at quit are marked `interrupted`.
- **Relaunch after restart**: interrupted tasks do **not** auto-resume; they
  show an "interrupted" marker and resume when the user opens them (the
  marker clears on the next session launch). Launches still **queued**
  (never started) do start when the app comes up.
- **Launching while the app is closed**: the launch is queued (the extension
  writes through its own core instance; the app's state-file watcher picks it
  up). The tool tells the agent "queued — starts when Harbormaster is
  running" so it does not assume work began.
- **Concurrency cap**: `launch.maxConcurrent` (default 6) counts launched
  tasks that are *working* (pty started and an agent turn running, or started
  but not yet reported presence). Idle "your move" children do not count.
  Launches beyond the cap stay queued.
- Launching never steals focus. The existing unread marker is the only
  "something happened" signal (no new notifications in v1).

## Completion and status

- **The board column belongs to the movers, unchanged.** A child that opens a
  draft PR stays in Dev (`observePullRequest`: a draft is "not awaiting
  anyone"); the user marking it ready / requesting review lets
  `githubReviewMover` move it to Awaiting/review. Agents never move their own
  card (`/toawait` stays a user command).
- **"Your move" is the attention signal.** A finished, blocked, or asking
  child is a live-but-idle session → amber "your move", exactly like any task.
  No separate "needs you" state.
- **Reported outcome is separate from `ended`.** `harbormaster_report_status`
  in a still-running session records `outcome` (done/blocked + note) on the
  presence record *without* ending it, so the task stays live ("your move")
  and the card can show the note as a secondary line. `ended` keeps its
  meaning: the process is gone.
- **Parent polling**: a `harbormaster_subtask_status` tool lists the parent's
  children with title, board column (+ awaiting kind), PR (number/state/url),
  presence (working / your move / not running / interrupted / queued) and
  the reported outcome + note. Report-and-poll only; no parent↔child
  messaging.
- **Completing a parent with active (non-Done) children** asks for
  confirmation first; children keep running and stay nested under the Done
  parent.

## Kickoff contract (appended to the launch prompt)

Adapted from pi-home's autonomy contract, but the user *can* answer:

1. Work only inside this task's worktree.
2. Run the repository's relevant checks/tests for your change.
3. Commit with a clear message and push the branch.
4. Open a DRAFT pull request (`gh pr create --draft`) targeting the default
   branch. If you based on / merged another task's branch, state the
   dependency at the top of the PR description.
5. If you are genuinely blocked or need a decision, stop and ask — the user
   sees your task as "your move". Otherwise do not stop to ask; make
   reasonable decisions and note them.
6. As your FINAL action call `harbormaster_report_status`: `done` with a
   one-line summary, or `blocked` with the concrete blocker.

Repository-less tasks skip 3-4. The kickoff also names the launching task
(title + id) for children, so the agent knows its context.

## Layering

- **core** (`packages/core`): model fields, `launchTask`, the launch queue
  (`claimPendingLaunches`), `markLaunchesInterrupted`, children query,
  Done-with-children confirmation, kickoff text, clone + scratch workspace
  access verbs, model flag in the Pi adapter, presence `outcome`.
- **app main** (`packages/app/src/main`): background launcher (queue
  consumer, cap), pty hosting without a pane + screen-state replay, attach
  IPC, interrupt marking at quit, IPC for the new commands.
- **extension** (`packages/extension`): `harbormaster_launch_task` and
  `harbormaster_subtask_status` tools; `harbormaster_report_status` records
  `outcome` instead of ending.
- **renderer**: children nested under parents (board + sidebar, chip
  "N children"), provenance line for standalone launches, outcome secondary
  line, interrupted/queued markers, "Launch subtask… / Launch task…" dialog
  in the task workspace header.
