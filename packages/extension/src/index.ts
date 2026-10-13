// Slim Pi extension — presence reporting only (wave 3b). Adoption commands,
// the temp write-guard, and the frozen TUI board are a later wave; see
// /docs/design-decisions.md and /AGENTS.md ("Agent harnesses are adapters").
//
// When a Harbormaster-launched Pi process starts (see
// `@harbormaster/core`'s `PiHarnessAdapter.buildLaunchSpec`, which sets
// `HARBORMASTER_TASK_ID` / `HARBORMASTER_STATE_DIR`), this extension
// registers presence, heartbeats on an interval, tracks turn boundaries, and
// ends its record on shutdown — the same liveness signal the core harness
// adapter's `presence()` reads back. Outside a Harbormaster-launched
// session (the env vars are absent — a bare `pi` run, or any other host)
// every hook below is a no-op.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  JsonTaskStateAccess,
  resolveStatePaths,
  SessionPresenceAccess,
} from "@harbormaster/core";
import { PresenceReporter } from "./presence-reporter.js";
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
    const mode = ctx.hasUI ? ("interactive" as const) : ("headless" as const);
    await reporter.start({ taskId, sessionPath, mode }).catch(() => {});
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      void reporter.heartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();

    const task = await taskState.getTask(taskId).catch(() => undefined);
    if (task) ctx.ui.setTitle(task.title);
    ctx.ui.setWidget(TASK_WIDGET_KEY, buildTaskWidgetLines(task, ctx.ui.theme));
    stopWidgetRefresh();
    widgetRefreshTimer = setInterval(() => {
      void refreshWidget(ctx).catch(() => {});
    }, TASK_WIDGET_REFRESH_INTERVAL_MS);
    widgetRefreshTimer.unref();
  });

  pi.on("turn_start", async () => {
    await reporter.setTurnActive(true).catch(() => {});
  });
  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
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
}
