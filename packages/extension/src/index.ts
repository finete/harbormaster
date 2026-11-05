// Pi extension — presence reporting, the in-session command surface, the
// task-launching agent tools (see /docs/design-decisions.md "Launching tasks
// from an agent" and /AGENTS.md: "Agent harnesses are adapters") and task
// messaging (see /docs/task-messaging.md "Extension").
//
// Two scopes:
// - Task-session machinery (presence, the task widget, /todev /toawait
//   /todone, `harbormaster_report_status`, `harbormaster_subtask_status`):
//   only meaningful inside a Harbormaster-launched Pi session (see
//   `@harbormaster/core`'s `PiHarnessAdapter.buildLaunchSpec`, which sets
//   `HARBORMASTER_TASK_ID` / `HARBORMASTER_STATE_DIR` /
//   `HARBORMASTER_SESSION_ID` / `HARBORMASTER_SESSION_PATH`). Outside one (a bare `pi` run, or any other
//   host) presence/widget/command registration is skipped entirely, and
//   `harbormaster_subtask_status` errors if ever called. Also here: the
//   inbox delivery of messages other tasks sent to this one (claimed from
//   core, delivered natively via `pi.sendMessage`) and the interactive-input
//   hook that tells core the user is steering this task.
// - `harbormaster_launch_task`: available in EVERY Pi session, task or not
//   (a `standalone` task may be launched from a plain Pi session with no
//   provenance; a `child` requires a task session). It writes through its
//   own `createCore` instance regardless (falling back to the default state
//   dir, `~/.harbormaster`, when `HARBORMASTER_STATE_DIR` is unset), so it
//   works even when the Harbormaster app isn't running (the launch is
//   queued; the app's watcher picks it up once it starts).
// - `harbormaster_find_tasks` / `harbormaster_send_to_task`: also available
//   in EVERY Pi session, thin wrappers over core's `findTasks` /
//   `sendTaskMessage`. The sender is this task only in the pane's own task
//   session (resolved at execution time), otherwise a non-task `session`
//   sender (always routed through user approval by core); never taken from
//   tool arguments.
//
// "Am I the task session" is resolved LAZILY (`sessionIsTask`, set inside
// the `session_start` handler) rather than at module-eval time: the
// inherited-env guard below only knows once a session has actually started
// whether this process is the pane's own session or a nested one (a
// pi-subagents child inheriting the same env with a different session id) —
// tools that care (a `child` launch, `harbormaster_subtask_status`) read it
// at EXECUTION time, never at registration time.

import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Core,
  createCore,
  JsonTaskStateAccess,
  type LaunchTaskInput,
  PiHarnessAdapter,
  resolveStatePaths,
  SessionPresenceAccess,
} from "@harbormaster/core";
import { Type } from "typebox";
import {
  buildChildStatusEntry,
  categorizeChildForWidget,
  formatChildrenSummaryLine,
  formatChildStatusText,
} from "./child-status.js";
import { HARBORMASTER_MESSAGE_TYPE, InboxDrainer } from "./inbox-delivery.js";
import {
  buildLaunchResultText,
  launchRepositoryLabel,
  resolveLaunchRepository,
} from "./launch-task-tool.js";
import { renderInboxMessage } from "./message-renderer.js";
import { PresenceReporter } from "./presence-reporter.js";
import {
  runToAwaitCommand,
  runToDevCommand,
  runToDoneCommand,
} from "./task-commands.js";
import {
  deriveMessageSender,
  formatTaskSearchText,
  resolveAttachmentPaths,
} from "./task-message-tools.js";
import { buildTaskWidgetLines } from "./task-widget.js";

/** Idle heartbeat cadence; well under PRESENCE_STALE_MS (3 minutes) so a live process never looks dead. */
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Task-widget refresh cadence while idle — ported from pi-home's IDLE_REFRESH_INTERVAL_MS. */
const TASK_WIDGET_REFRESH_INTERVAL_MS = 30_000;
/** `ctx.ui.setWidget()` key for the task-context widget (distinct from pi-home's "pi-home-task"). */
const TASK_WIDGET_KEY = "harbormaster-task";

export default function harbormasterExtension(pi: ExtensionAPI): void {
  const taskId = process.env.HARBORMASTER_TASK_ID;
  const stateDirEnv = process.env.HARBORMASTER_STATE_DIR;
  const expectedSessionId = process.env.HARBORMASTER_SESSION_ID;
  const expectedSessionPath = process.env.HARBORMASTER_SESSION_PATH;

  // One core instance for the whole process, used by every tool below —
  // `createCore` registers no timers of its own, so holding onto this
  // instance does nothing automatic (movers tick only in the app). When
  // `HARBORMASTER_STATE_DIR` is unset (a plain Pi session, not Harbormaster-
  // hosted) this resolves to the default state dir so
  // `harbormaster_launch_task` still works standalone.
  const core: Core = createCore(stateDirEnv ? { stateDir: stateDirEnv } : {});
  // Shares the same state dir as `core`'s presence access; used by the
  // children-status machinery (the widget summary line,
  // `harbormaster_subtask_status`) to read a child's liveness.
  const harness = new PiHarnessAdapter(
    stateDirEnv ? { stateDir: stateDirEnv } : {},
  );

  // Resolved once `session_start` actually runs (see the inherited-env
  // guard below); `false` for the whole process when there is no
  // `HARBORMASTER_TASK_ID` at all (a non-Harbormaster session).
  let sessionIsTask = false;

  if (taskId && stateDirEnv) {
    const paths = resolveStatePaths(stateDirEnv);
    const presence = new SessionPresenceAccess(paths.presenceDir);
    const reporter = new PresenceReporter({ presence, pid: process.pid });
    // Read-only: the task-widget refresh never writes task state (accessor
    // rules hold — Managers/Engines own task mutation; this is a plain,
    // read-only use of the same JSON accessor core's manager uses).
    const taskState = new JsonTaskStateAccess(
      paths.tasksFile,
      paths.tasksLockFile,
    );

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };

    let widgetRefreshTimer: ReturnType<typeof setInterval> | undefined;
    const stopWidgetRefresh = (): void => {
      if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
      widgetRefreshTimer = undefined;
    };

    // Live task-context widget, modeled on pi-home's home-controller
    // `setTaskStatus()`: a compact PR/column summary (plus a children
    // run-state summary when this task has any) above the editor, kept
    // fresh on session start, every turn boundary, and a 30s idle timer.
    // The task vanishing from state (deleted) clears the widget instead of
    // throwing — `getTask()` resolves to `undefined` either way.
    const refreshWidget = async (ctx: ExtensionContext): Promise<void> => {
      const task = await taskState.getTask(taskId).catch(() => undefined);
      const childrenSummary = task
        ? await computeChildrenSummaryLine(core, harness, task.id)
        : undefined;
      ctx.ui.setWidget(
        TASK_WIDGET_KEY,
        buildTaskWidgetLines(task, ctx.ui.theme, childrenSummary),
      );
    };

    // Inbox delivery (task-messaging): only this pane's own task session
    // ever claims (nested/subagent sessions return before `sessionIsTask`
    // is set). Drains are serialized by `InboxDrainer`; they are triggered
    // by session start, core's inbox doorbell, every agent-loop end (queued
    // followUps become claimable once idle) and the heartbeat as a backstop.
    // The latest context is kept for `ctx.isIdle()`; it is dropped on
    // session switch/shutdown so a stale one is never consulted.
    let inboxCtx: ExtensionContext | undefined;
    let unsubscribeInbox: (() => void) | undefined;
    const stopInbox = (): void => {
      unsubscribeInbox?.();
      unsubscribeInbox = undefined;
      inboxCtx = undefined;
    };
    const drainer = new InboxDrainer({
      claim: (options) => core.commands.claimInboxMessages(taskId, options),
      isIdle: () => inboxCtx?.isIdle() ?? false,
      readAttachment: (messageId, index) =>
        core.commands.readMessageAttachment(messageId, index),
      send: (message, options) => pi.sendMessage(message, options),
    });
    const drainInbox = (): Promise<void> =>
      sessionIsTask && inboxCtx ? drainer.drain() : Promise.resolve();

    pi.registerMessageRenderer(
      HARBORMASTER_MESSAGE_TYPE,
      (message, options, theme) => renderInboxMessage(message, options, theme),
    );

    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath) return;
      // Inherited-env guard (pi-home stripped CMUX_* for the same reason):
      // nested pi processes — pi-subagents children, nested `pi` runs —
      // inherit HARBORMASTER_* but open their own sessions. Only the
      // process whose session is the one the pane launched may own
      // presence/binding/widget (and the task-session-only tools below);
      // everything else stands down. (Running /new inside a pane also
      // mismatches: presence goes quiet until the pane is reopened —
      // flagged tradeoff, far better than children overwriting the
      // record.) The pane's session is the one with the expected id or,
      // when the pane opened a specific file, that file: a recorded
      // conversation whose id core never knew (a pi-home import) or knew
      // wrongly is still the pane's own; a nested child matches neither.
      const isPaneSession =
        (!expectedSessionId && !expectedSessionPath) ||
        (expectedSessionId !== undefined &&
          ctx.sessionManager.getSessionId() === expectedSessionId) ||
        (expectedSessionPath !== undefined &&
          resolve(sessionPath) === resolve(expectedSessionPath));
      if (!isPaneSession) {
        sessionIsTask = false;
        return;
      }
      sessionIsTask = true;
      const mode = ctx.hasUI ? ("interactive" as const) : ("headless" as const);
      await reporter.start({ taskId, sessionPath, mode }).catch(() => {});
      // Session-binding capture point: only this Pi process knows the
      // exact session file it opened, so it reports it through core's
      // command API (never by writing the binding itself). Core records it
      // only for the task's bound session id, so resuming later uses
      // `pi --session <file>`.
      await core.commands
        .recordTaskSession(taskId, {
          sessionId: ctx.sessionManager.getSessionId(),
          sessionPath,
        })
        .catch(() => false);
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        void reporter.heartbeat().catch(() => {});
        void drainInbox().catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();

      // Presence is registered: this session can now receive. Subscribe to
      // the inbox doorbell, then claim whatever is already waiting (held
      // while queued, or sent while the session was down).
      stopInbox();
      inboxCtx = ctx;
      unsubscribeInbox = core.commands.subscribeInbox(taskId, () => {
        void drainInbox().catch(() => {});
      });
      void drainInbox().catch(() => {});

      const task = await taskState.getTask(taskId).catch(() => undefined);
      if (task) {
        ctx.ui.setTitle(task.title);
        // pi-home names the task's Pi session after the task (its
        // `appendSessionInfo`/`setSessionName`), so `/resume` and the
        // session selector show the task instead of the first prompt. Only
        // written when it differs: each rename appends a session-info
        // entry.
        if (pi.getSessionName() !== task.title) pi.setSessionName(task.title);
      }
      await refreshWidget(ctx).catch(() => {});
      stopWidgetRefresh();
      widgetRefreshTimer = setInterval(() => {
        void refreshWidget(ctx).catch(() => {});
      }, TASK_WIDGET_REFRESH_INTERVAL_MS);
      widgetRefreshTimer.unref();
    });

    // Running state spans the whole agent loop (pi-home parity), not a
    // single LLM turn: between tool-call turns the agent is still working,
    // so turn_start/turn_end would flicker the board between running and
    // "your move" mid-run.
    pi.on("agent_start", async () => {
      await reporter.setTurnActive(true).catch(() => {});
    });
    pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
      await reporter.setTurnActive(false).catch(() => {});
      if (sessionIsTask) inboxCtx = ctx;
      await refreshWidget(ctx).catch(() => {});
      await drainInbox().catch(() => {});
    });
    // A blocking user-facing prompt (a `ctx.ui.select`/`confirm`/`input`
    // from any extension; the commit gate is the motivating case) parks the
    // agent loop on the user: nothing proceeds until they act. Report it as
    // "your move" (not "working") for its duration, then restore the loop's
    // running state when the prompt resolves. These fire regardless of the
    // loop (e.g. a slash-command prompt while idle); the reporter folds them
    // together (effective running = loop active AND no prompt pending), so an
    // idle prompt stays idle and a mid-turn gate flips working to your move.
    pi.on("ui_prompt_start", async () => {
      await reporter.setPromptPending(true).catch(() => {});
    });
    pi.on("ui_prompt_end", async () => {
      await reporter.setPromptPending(false).catch(() => {});
    });
    // `agent_end` can fire while Pi still reports streaming; `agent_settled`
    // is when it is truly idle, so queued followUps are claimed then too.
    pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
      if (sessionIsTask) inboxCtx = ctx;
      await drainInbox().catch(() => {});
    });

    // The user typing into this task's session resets the loop cap and ends
    // "waiting on parent" (core decides); fire-and-forget, input untouched.
    pi.on("input", async (event) => {
      if (event.source === "interactive" && sessionIsTask) {
        void core.commands.recordUserInput(taskId).catch(() => {});
      }
      return { action: "continue" as const };
    });

    pi.on("session_before_switch", async () => {
      stopInbox();
      stopHeartbeat();
      stopWidgetRefresh();
      await reporter.end().catch(() => {});
      return undefined;
    });
    pi.on("session_shutdown", async () => {
      stopInbox();
      stopHeartbeat();
      stopWidgetRefresh();
      await reporter.end().catch(() => {});
    });

    // The three invariant verbs (decision #16 in /docs/design-decisions.md):
    // todev / toawait / todone. No kind-named commands — awaiting kinds are
    // data the one /toawait verb is parameterized with (`listAwaitingKinds`).
    // Each command calls the command API (never touches state directly) and
    // refreshes the task widget right after, so the compact PR/column
    // summary reflects the move without waiting for the next turn boundary
    // or the 30s idle timer.
    pi.registerCommand("todev", {
      description: "Move this task to Dev",
      handler: async (_args, ctx: ExtensionCommandContext) => {
        await runToDevCommand(core, taskId, ctx.ui);
        await refreshWidget(ctx).catch(() => {});
      },
    });
    pi.registerCommand("toawait", {
      description: "Choose what this task is awaiting",
      handler: async (_args, ctx: ExtensionCommandContext) => {
        await runToAwaitCommand(core, taskId, ctx.ui);
        await refreshWidget(ctx).catch(() => {});
      },
    });
    pi.registerCommand("todone", {
      description: "Complete this task and clean its workspace",
      handler: async (_args, ctx: ExtensionCommandContext) => {
        // Protect this session's own worktree (its cwd): /todone runs inside
        // the task's live Pi session, so without this `toDone` would remove
        // the worktree out from under the running session. Left in place with
        // a warning; the app's refresh sweep reaps it once the pane closes.
        await runToDoneCommand(core, taskId, ctx.ui, {
          protectedPaths: [process.cwd()],
        });
        await refreshWidget(ctx).catch(() => {});
      },
    });

    // Agent-facing status tool — the replacement for pi-home's
    // `pihome_report_status` muscle memory in resumed sessions. Writes
    // through the same `PresenceAccess` the reporter above registers with,
    // so the app's unread/attention surfaces (which read presence, not the
    // command API — presence is still a phase-2 seam in `createCore`, see
    // its comment) pick the outcome up; `reporter.isAttached` guards
    // against reporting onto a registration that failed or already ended.
    // The session STAYS OPEN after reporting (core's `reportOutcome`
    // records the verdict without ending the attachment): the user sees
    // this task as "your move", exactly like any other finished/blocked
    // child, not as gone.
    pi.registerTool({
      name: "harbormaster_report_status",
      label: "Harbormaster report status",
      description:
        "Report the terminal outcome of this Harbormaster task run. Call this as your FINAL action when working autonomously: status 'done' with a one-line summary of what was delivered, or 'blocked' with the concrete blocker. The session stays open after this call (it is not ended) — the user sees your task as 'your move'. Only valid inside a session linked to a Harbormaster task.",
      parameters: Type.Object({
        status: Type.Union([Type.Literal("done"), Type.Literal("blocked")], {
          description:
            "done = objective delivered; blocked = cannot proceed without help",
        }),
        note: Type.Optional(
          Type.String({
            description:
              "One-line summary (done) or the concrete blocker (blocked)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!reporter.isAttached) {
          throw new Error(
            "This session is not linked to a Harbormaster task; status was not recorded.",
          );
        }
        const note = params.note?.trim() || undefined;
        await presence.reportOutcome(
          taskId,
          process.pid,
          params.status,
          note,
          new Date().toISOString(),
        );
        return {
          content: [
            {
              type: "text",
              text: `Recorded ${params.status}${note ? `: ${note}` : ""}`,
            },
          ],
          details: undefined,
        };
      },
    });
  }

  // Agent-facing poll for a parent's children (see
  // /docs/design-decisions.md "Launching tasks from an agent"; steering a
  // child is `harbormaster_send_to_task`). Registered
  // in EVERY session (like `harbormaster_launch_task`), but "task sessions
  // only; error otherwise": it guards on `sessionIsTask` at EXECUTION time,
  // never at registration time, so a nested subagent inheriting this same
  // env (or any non-Harbormaster session) can never poll as if it were the
  // pane's own task session.
  pi.registerTool({
    name: "harbormaster_subtask_status",
    label: "Harbormaster subtask status",
    description:
      'List this task\'s child tasks (launched with relation "child"): title, id, board column (plus the awaiting reason), PR info when opened, run state (queued / interrupted / working / your move / not running), and the reported outcome. Only valid inside a Harbormaster task session.',
    parameters: Type.Object({}),
    async execute() {
      if (!sessionIsTask || !taskId) {
        throw new Error(
          "harbormaster_subtask_status is only available inside a Harbormaster task session.",
        );
      }
      const children = await core.commands.listChildren(taskId);
      const entries = await Promise.all(
        children.map(async (child) => {
          const childPresence = await harness.presence(child.id);
          return buildChildStatusEntry(child, childPresence);
        }),
      );
      return {
        content: [{ type: "text", text: formatChildStatusText(entries) }],
        details: { children: entries },
      };
    },
  });

  // `harbormaster_find_tasks` / `harbormaster_send_to_task` — task messaging
  // (see /docs/task-messaging.md). Registered in EVERY session; whether this
  // is the pane's own task session is read at EXECUTION time, exactly like
  // `harbormaster_subtask_status`.
  pi.registerTool({
    name: "harbormaster_find_tasks",
    label: "Harbormaster find tasks",
    description:
      "Find Harbormaster tasks by plain words (title, repository, branch, PR number like #412, or id prefix; every word must match). Use it to resolve a task the user names to its exact id before harbormaster_send_to_task. Each match shows id, title, board column, run state, relation to this task (self / parent / child / sibling / unrelated) and repository/branch/PR when present. Finished (Done) tasks are left out unless includeDone is true.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Plain words to match, e.g. a title fragment or PR number.",
      }),
      includeDone: Type.Optional(
        Type.Boolean({
          description: "Also search Done tasks (default false).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const results = await core.commands.findTasks(params.query, {
        ...(sessionIsTask && taskId ? { fromTaskId: taskId } : {}),
        ...(params.includeDone ? { includeDone: true } : {}),
      });
      return {
        content: [
          { type: "text", text: formatTaskSearchText(results, params.query) },
        ],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "harbormaster_send_to_task",
    label: "Harbormaster send to task",
    description:
      'Send a message to another Harbormaster task\'s agent. taskId must be an EXACT task id (use harbormaster_find_tasks first; never guess). Messages to your own children or to your parent are delivered directly. ANY other target (sibling, unrelated task, or any send from a plain non-task Pi session) goes to the user\'s approval in the Harbormaster app, so send those ONLY when the user explicitly asked you to. mode: "steer" lands after the target\'s current step (use for corrections); "followUp" lands after the target finishes its current work (the default for questions to your parent). After asking your parent a question, end your turn and wait for the reply; do not poll. attachments are file paths (e.g. pasted screenshots) that are copied and, for images, shown to the target; everything else is text only.',
    parameters: Type.Object({
      taskId: Type.String({
        description:
          "Exact id of the target task (from harbormaster_find_tasks, harbormaster_launch_task or harbormaster_subtask_status).",
      }),
      message: Type.String({ description: "The message text." }),
      mode: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
          description:
            "steer = after the target's current step (corrections); followUp = after it finishes its current work. Default: steer to a child, followUp to a parent.",
        }),
      ),
      attachments: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "File paths to attach (relative paths resolve against the current directory).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = process.cwd();
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const attachments = resolveAttachmentPaths(params.attachments, cwd);
      const result = await core.commands.sendTaskMessage({
        from: deriveMessageSender({
          sessionIsTask,
          taskId,
          cwd,
          ...(sessionId ? { sessionId } : {}),
        }),
        targetTaskId: params.taskId,
        text: params.message,
        ...(params.mode ? { mode: params.mode } : {}),
        ...(attachments ? { attachments } : {}),
      });
      return {
        content: [{ type: "text", text: result.note }],
        details: {
          messageId: result.message.id,
          route: result.message.route,
          status: result.message.status,
          willWake: result.willWake,
        },
      };
    },
  });

  // `harbormaster_launch_task` — available in EVERY Pi session (see this
  // file's header comment). `relation` has no default: the PRD's lesson
  // (Orca) is that guessing child-vs-standalone goes wrong, so the agent
  // must state it explicitly every time.
  pi.registerTool({
    name: "harbormaster_launch_task",
    label: "Harbormaster launch task",
    description:
      'Launch a new Harbormaster task that starts running immediately in the background, in its own git worktree/branch and its own session — never in this one. `relation` is REQUIRED with no default; choose explicitly every time: "child" ONLY when the work is part of / depends on the current task (nested under it on the board; poll it with harbormaster_subtask_status); "standalone" for an independent fix, a different repository, or an unrelated follow-up that parts ways from this one. A "child" requires calling this from a Harbormaster task session. The launch is QUEUED: it starts in the background once the Harbormaster app is running, so never assume the work has begun. Call this tool once per task; call it again (with a fresh prompt) to launch several.',
    parameters: Type.Object({
      relation: Type.Union(
        [Type.Literal("child"), Type.Literal("standalone")],
        {
          description:
            'No default: "child" only when the work is part of / depends on the current task; "standalone" for independent fixes, other repositories, or unrelated follow-ups.',
        },
      ),
      title: Type.String({ description: "Short task title for the board." }),
      prompt: Type.String({
        description:
          "Self-sufficient instructions for the launched agent: it starts a fresh session with no other context than this prompt (and, for a child, the launching task's title/id).",
      }),
      repository: Type.String({
        description:
          '"none" for no repository (a scratch task), a discovered repository id (e.g. "github.com/org/repo") or its unique short name, or a git clone URL to clone a new one.',
      }),
      baseBranch: Type.Optional(
        Type.Union([Type.Literal("default"), Type.Literal("parent")], {
          description:
            '"parent" (stacked work, off the parent\'s branch) is only valid for a "child" launched in the SAME repository as its parent, once the parent has a branch; never for "standalone". Omit or use "default" to branch off the repository\'s default branch.',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Provider/model override for this task's first session; falls back to the configured default, then the harness default.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const fromTaskId = sessionIsTask ? taskId : undefined;
      if (params.relation === "child" && !fromTaskId) {
        throw new Error(
          "child requires launching from a Harbormaster task session",
        );
      }
      const repositories = await core.commands.listRepositories();
      const repository = resolveLaunchRepository(
        params.repository,
        repositories,
      );
      const input: LaunchTaskInput = {
        relation: params.relation,
        ...(fromTaskId ? { fromTaskId } : {}),
        title: params.title,
        prompt: params.prompt,
        repository,
        ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
        ...(params.model ? { model: params.model } : {}),
      };
      const task = await core.commands.launchTask(input);
      const text = buildLaunchResultText({
        title: task.title,
        id: task.id,
        relation: params.relation,
        repositoryLabel: launchRepositoryLabel(repository),
      });
      return {
        content: [{ type: "text", text }],
        details: { task },
      };
    },
  });
}

/** Children-run-state summary for the task widget (see `child-status.ts`); `undefined` when the task has no children. */
async function computeChildrenSummaryLine(
  core: Core,
  harness: PiHarnessAdapter,
  parentTaskId: string,
): Promise<string | undefined> {
  const children = await core.commands
    .listChildren(parentTaskId)
    .catch(() => []);
  if (!children.length) return undefined;
  const categories = await Promise.all(
    children.map(async (child) => {
      const childPresence = await harness.presence(child.id);
      return categorizeChildForWidget(child, childPresence);
    }),
  );
  return formatChildrenSummaryLine(categories);
}
