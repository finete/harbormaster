# Task trees: deeper nesting and wider direct messaging

Status: agreed design (grilled 2026-11-21). Revises two rules:
`docs/task-messaging.md` decision 2 ("parent ↔ child direct, everything
else needs approval") and decision 10 (the loop cap counts only
parent–child pairs), and the "one level only" nesting rule
(`docs/design-decisions.md`, `CoreCommands.setTaskParent`,
`LaunchTaskInput.relation`).

Researched against Paseo (any agent on the host messages any other, no
gate, no depth limit), Herdr (any pane by id, no gate, no hierarchy in
the TUI), Orca (orchestration mail incl. `@all`, "Nested worker depth"
setting, default 4, stopping a worker stops its helpers), Claude Code
(subagents nest 3 layers by default, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`;
agent teams: any teammate messages any other, no nested teams), Codex
(no documented depth setting), Gemini CLI (subagents cannot call
subagents). None of them gates messages between agents with user
approval, and none caps message round trips (Harbormaster's cap comes
from opencode).

## Terms

- **Task tree**: a top-level task (no `parentTaskId`) and every task
  below it, at any depth. Two tasks are in the same tree when they have
  the same top-level ancestor.
- **Depth**: a top-level task is depth 1, its children depth 2, and so on.
- **Direct link**: a task and its own parent (one `parentTaskId` hop).
  "Parent" and "child" always mean the direct link, never grandparents.

## Decisions

| # | Decision |
|---|---|
| 1 | **Setting "Messages between tasks"** (`messaging.directRoutes`, Settings → Inbox & messaging): `parent-and-child` (direct links only) / `same-task-tree` (any two tasks in the same tree) / `any-task`. **Default `same-task-tree`.** One app-wide value; no per-repo or per-task override. |
| 2 | A task → task send the setting does not allow goes to **user approval**, as today. **Non-task senders** (plain sessions, rule `message` actions) **always** need approval, whatever the setting. |
| 3 | **Loop cap** (`messaging.loopCap`, default 8, existing Settings row) applies to **every pair of tasks that talks directly** (by setting or by a pair grant, decision 15): per unordered pair, both directions, approved sends and receipts never count, resets when the user types into either task. The help text says "any two tasks talking directly". |
| 4 | **Steer** stays available on every direct route; no downgrade to followUp for non-parent senders. |
| 5 | **Agents learn the rule from core, not from a copied sentence.** `send_to_task`'s description says the route depends on the user's setting (keeping "send approval-route messages ONLY when the user explicitly asked you to"); `find_tasks` marks each result `direct` or `needs approval` for the calling task; the send result says "delivered" or "waiting for the user's approval". |
| 6 | **"Waiting on parent"** and `messaging.parentReplyTimeoutMinutes` stay direct-parent-only. |
| 7 | **Setting "Max nesting depth"** (`launch.maxNestingDepth`, Settings → Agents, next to `launch.maxConcurrent`): integer 1–4, **default 3**, no unlimited option. 1 = today's behaviour (no children); 3 = grandchildren allowed. |
| 8 | **At the limit:** a `child` launch from a task at the max depth is refused: "you're at the max nesting depth (N); do the work yourself or launch a standalone task". Never silently turned into standalone. A task launched **at** the max depth gets one line in its kickoff saying it cannot launch subtasks. |
| 9 | **Lowering the setting** never moves or detaches tasks; it only blocks new nesting. Messaging follows the tree as it stands. The setting row shows a note when trees deeper than the value exist ("N task trees are deeper than this; they're left as they are"). |
| 10 | **Manual re-nesting** (`setTaskParent`) moves the task **with its whole subtree**; refused only when the result would exceed the max depth, or would put a task under itself or its own descendant (a cycle). |
| 11 | **Board and sidebar draw one indent per level**; each parent collapses on its own (`harbormaster.lineage.collapsedParents`). Existing rules carry over per link: a task whose parent is in another column (rail: not open, pinned, or filtered out) keeps its own place with a "↳ parent" line; the top-level task's repo group hosts the tree. |
| 12 | **Done with active tasks below:** the `activeChildren` confirmation covers the **whole subtree** and lists every active descendant. Default leaves them running (today). The dialog has an **"Also stop these N tasks"** checkbox with a warning ("their agents are interrupted mid-work"), **off by default and every time the dialog opens**. Ticked, it stops those agents only: tasks stay on the board in their columns with worktrees and uncommitted changes untouched. |
| 13 | **`subtask_status`** lists **direct children only**, each with a count of active tasks below it ("2 tasks below still running"). |
| 14 | **Costs:** a task's subtask total includes **every task below it**, each counted once. |
| 15 | **Pair grant, "Approve and allow both ways":** a second button on a task → task approval (never shown for non-task senders or rules). It delivers the message and lets that pair message each other directly in both directions from then on. Scope: that pair only. Lasts until either task is Done or deleted; removable from either task's menu ("Stop direct messages with X"). The loop cap applies. Plain **Approve** stays the default and approves one message. `find_tasks` shows a granted pair as `direct`. |

## Coordination

The "inbox bug" task (`finete/inbox-bug-1af25f`) is changing, in the same
area: `recordUserInput` only for real user input, an optional
`expectsReply` on `send_to_task` (accepted on any send; only a send to the
direct parent sets "waiting on parent"), a delivery-time "call
report_status" reminder decided by the receiver, and the child's open
question in `subtask_status`. Whichever lands second rebases onto the
other; expect small conflicts in the `send_to_task` description
(`tools/catalog.ts`), `engines/messaging.ts`, and `tools/child-status.ts`.
