// Slim Pi extension — presence reporting only (wave 3b). Adoption commands,
// the temp write-guard, and the frozen TUI board are a later wave; see
// /docs/design-decisions.md and /AGENTS.md ("Agent harnesses are adapters").
//
// When a Harbormaster-launched Pi process starts (see
// `@harbormaster/core`'s `PiHarnessAdapter.buildLaunchSpec`, which sets
// `HARBORMASTER_TASK_ID` / `HARBORMASTER_STATE_DIR`), this extension
// registers presence, heartbeats on an interval, tracks agent-loop
// boundaries (agent_start/agent_end), names the session after the task, and
// ends its record on shutdown — the same liveness signal the core harness
// adapter's `presence()` reads back. Outside a Harbormaster-launched
// session (the env vars are absent — a bare `pi` run, or any other host)
// every hook below is a no-op.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createCore,
  JsonTaskStateAccess,
  resolveStatePaths,
  SessionPresenceAccess,
} from "@harbormaster/core";
import { Type } from "typebox";
import { PresenceReporter } from "./presence-reporter.js";
import {
  runToAwaitCommand,
  runToDevCommand,
  runToDoneCommand,
} from "./task-commands.js";
import { buildTaskWidgetLines } from "./task-widget.js";

/** Idle heartbeat cadence; well under PRESENCE_STALE_MS (3 minutes) so a live process never looks dead. */
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Task-widget refresh cadence while idle — ported from pi-home's IDLE_REFRESH_INTERVAL_MS. */
const TASK_WIDGET_REFRESH_INTERVAL_MS = 30_000;
/** `ctx.ui.setWidget()` key for the task-context widget (distinct from pi-home's "pi-home-task"). */
const TASK_WIDGET_KEY = "harbormaster-task";

export default function harbormasterExtension(pi: ExtensionAPI): void {
  const taskId = process.env.HARBORMASTER_TASK_ID;
  const stateDir = process.env.HARBORMASTER_STATE_DIR;
  // Not a Harbormaster-hosted session (plain `pi`, or a non-Harbormaster
  // host): presence reporting has nothing to report against.
  if (!taskId || !stateDir) return;

  const paths = resolveStatePaths(stateDir);
  const presence = new SessionPresenceAccess(paths.presenceDir);
  const reporter = new PresenceReporter({ presence, pid: process.pid });
  // One core instance for the whole process: frontends call the command API,
  // movers tick only in the app — `createCore` registers no timers of its
  // own, so holding onto this instance does nothing automatic.
  const core = createCore({ stateDir });
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
  // `setTaskStatus()`: a compact PR/column summary above the editor, kept
  // fresh on session start, every turn boundary, and a 30s idle timer. The
  // task vanishing from state (deleted) clears the widget instead of
  // throwing — `getTask()` resolves to `undefined` either way.
  const refreshWidget = async (ctx: ExtensionContext): Promise<void> => {
    const task = await taskState.getTask(taskId).catch(() => undefined);
    ctx.ui.setWidget(TASK_WIDGET_KEY, buildTaskWidgetLines(task, ctx.ui.theme));
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) return;
    // Inherited-env guard (pi-home stripped CMUX_* for the same reason):
    // nested pi processes — pi-subagents children, nested `pi` runs — inherit
    // HARBORMASTER_* but open their own sessions. Only the process whose
    // session is the one the pane launched may own presence/binding/widget;
    // everything else stands down. (Running /new inside a pane also
    // mismatches: presence goes quiet until the pane is reopened — flagged
    // tradeoff, far better than children overwriting the record.)
    const expectedSessionId = process.env.HARBORMASTER_SESSION_ID;
    if (
      expectedSessionId &&
      ctx.sessionManager.getSessionId() !== expectedSessionId
    ) {
      return;
    }
    const mode = ctx.hasUI ? ("interactive" as const) : ("headless" as const);
    await reporter.start({ taskId, sessionPath, mode }).catch(() => {});
    // Session-binding capture point: only this Pi process knows the exact
    // session file it opened, so it reports it through core's command API
    // (never by writing the binding itself). Core records it only for the
    // task's bound session id, so resuming later uses `pi --session <file>`.
    await core.commands
      .recordTaskSession(taskId, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionPath,
      })
      .catch(() => false);
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      void reporter.heartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();

    const task = await taskState.getTask(taskId).catch(() => undefined);
    if (task) {
      ctx.ui.setTitle(task.title);
      // pi-home names the task's Pi session after the task (its
      // `appendSessionInfo`/`setSessionName`), so `/resume` and the session
      // selector show the task instead of the first prompt. Only written
      // when it differs: each rename appends a session-info entry.
      if (pi.getSessionName() !== task.title) pi.setSessionName(task.title);
    }
    ctx.ui.setWidget(TASK_WIDGET_KEY, buildTaskWidgetLines(task, ctx.ui.theme));
    stopWidgetRefresh();
    widgetRefreshTimer = setInterval(() => {
      void refreshWidget(ctx).catch(() => {});
    }, TASK_WIDGET_REFRESH_INTERVAL_MS);
    widgetRefreshTimer.unref();
  });

  // Running state spans the whole agent loop (pi-home parity), not a single
  // LLM turn: between tool-call turns the agent is still working, so
  // turn_start/turn_end would flicker the board between running and "your
  // move" mid-run.
  pi.on("agent_start", async () => {
    await reporter.setTurnActive(true).catch(() => {});
  });
  pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
    await reporter.setTurnActive(false).catch(() => {});
    await refreshWidget(ctx).catch(() => {});
  });

  pi.on("session_before_switch", async () => {
    stopHeartbeat();
    stopWidgetRefresh();
    await reporter.end().catch(() => {});
    return undefined;
  });
  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    stopWidgetRefresh();
    await reporter.end().catch(() => {});
  });

  // The three invariant verbs (decision #16 in /docs/design-decisions.md):
  // todev / toawait / todone. No kind-named commands — awaiting kinds are
  // data the one /toawait verb is parameterized with (`listAwaitingKinds`).
  // Each command calls the command API (never touches state directly) and
  // refreshes the task widget right after, so the compact PR/column summary
  // reflects the move without waiting for the next turn boundary or the 30s
  // idle timer.
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
      await runToDoneCommand(core, taskId, ctx.ui);
      await refreshWidget(ctx).catch(() => {});
    },
  });

  // Agent-facing status tool — the replacement for pi-home's
  // `pihome_report_status` muscle memory in resumed sessions. Writes through
  // the same `PresenceAccess` the reporter above registers with, so the
  // app's unread/attention surfaces (which read presence, not the command
  // API — presence is still a phase-2 seam in `createCore`, see its
  // comment) pick the outcome up; `reporter.isAttached` guards against
  // reporting onto a registration that failed or already ended.
  pi.registerTool({
    name: "harbormaster_report_status",
    label: "Harbormaster report status",
    description:
      "Report the terminal outcome of this Harbormaster task run. Call this as your FINAL action when working autonomously: status 'done' with a one-line summary of what was delivered, or 'blocked' with the concrete blocker. Only valid inside a session linked to a Harbormaster task.",
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
