// Electron main process entry — see /AGENTS.md for the fixed UI stack.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type {
  AwaitingKindId,
  BoardColumn,
  CreateTaskInput,
  LaunchTaskInput,
  MessageMode,
  MoveTaskOptions,
  ReopenTaskInput,
  Task,
  TaskState,
  ToAwaitOptions,
  UpdateTaskInput,
} from "@harbormaster/core";
import {
  createCore,
  DEFAULT_STATE_DIR,
  execFileRunner,
  isConnectivityError,
  PiHarnessAdapter,
  resolveStatePaths,
  setProcessRunner,
} from "@harbormaster/core";
import type { WebContents } from "electron";
import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  net,
  powerMonitor,
  shell,
  utilityProcess,
} from "electron";
import type {
  MessagingChangedPayload,
  PresenceChangedPayload,
  PresenceSnapshot,
  TerminalCreateOptions,
  TerminalCreateResult,
  ToDoneForce,
} from "../preload/api";
import { isCloseTabChord, isSidebarCycleChord } from "./app-shortcuts";
import { createBackgroundLauncher } from "./background-launcher";
import type { ConnectivityState } from "./connectivity-loop";
import { createConnectivityLoop } from "./connectivity-loop";
import {
  githubHostsFromRepositoryIds,
  isAllowedExternalUrl,
} from "./external-url";
import {
  createDedupedPusher,
  createIntervalGate,
  isMessagesLogChange,
  PRUNE_INTERVAL_MS,
} from "./messaging-push";
import { wirePowerGating } from "./power-gating";
import { corroboratePresence } from "./presence-corroboration";
import { createPushDedupe, createSingleFlight } from "./presence-push";
import { resolvePrimaryLaunch } from "./primary-launch";
import {
  acknowledgeSessionData,
  activeSessionCwds,
  activeSessionPids,
  attachPrimarySession,
  createBackgroundPrimarySession,
  createSession,
  detachPrimarySession,
  disposeAllSessions,
  disposeSession,
  getSession,
  lookupPanePid,
  resizeSession,
  writeToSession,
} from "./ptySessions";
import { isAllowedRevealPath } from "./reveal-path";
import { createSpawnHostRunner } from "./spawn-host-client";
import { registerTerminalHostIpc } from "./terminal-host-ipc";
import { createWakeLog, isWakeLogWorthy } from "./wake-log";
import { WarmSessionCache } from "./warm-sessions";

// Surface main-process crashes to stderr instead of letting Electron's
// default "uncaught exception" dialog pop up in front of the user. Node only
// performs that default dialog-and-possibly-exit behavior when there is *no*
// listener registered, so this also doubles as the fix for pty/IPC bugs that
// would otherwise crash-dialog on a destroyed-window race.
process.on("uncaughtException", (error) => {
  console.error("[main] uncaughtException:", error);
});

// Tracks which pty session ids belong to which renderer webContents, so a
// destroyed window/webContents can never be the target of a dangling
// `webContents.send()` and every session it owns is torn down with it —
// even if the renderer never got the chance to call `terminal.dispose()`
// (force-close, crash, app quit mid-session, etc).
const sessionsByWebContentsId = new Map<number, Set<string>>();

function trackSession(webContentsId: number, sessionId: string): void {
  let ids = sessionsByWebContentsId.get(webContentsId);
  if (!ids) {
    ids = new Set();
    sessionsByWebContentsId.set(webContentsId, ids);
  }
  ids.add(sessionId);
}

function untrackSession(webContentsId: number, sessionId: string): void {
  sessionsByWebContentsId.get(webContentsId)?.delete(sessionId);
}

/** Task ids whose agent was mid-turn at the last presence tick (eviction skips them). */
let workingTaskIds = new Set<string>();

/**
 * Closed-tab task primaries kept warm for an instant reopen (see
 * warm-sessions.ts and `pty:release`). Only an explicit tab close feeds it:
 * a window reload detaches every pane at once (`releaseSessionsFor`) and
 * must keep them all to re-attach.
 */
const warmSessions = new WarmSessionCache({
  isWarm: (id) => {
    const session = getSession(id);
    return Boolean(session && !session.attached);
  },
  taskIdOf: (id) => getSession(id)?.taskId,
  isWorking: (taskId) => workingTaskIds.has(taskId),
  dispose: (id) => disposeSession(id),
});

/**
 * The renderer behind `webContentsId` started over without its panes
 * running their cleanup (window reload, renderer crash: the webContents
 * survives, so no 'destroyed' fires). Task primaries go back to the
 * background so the reloaded panes re-attach to the same pi; every other
 * pty ("+ terminal" shells) is disposed as the old pane is gone.
 */
function releaseSessionsFor(webContentsId: number): void {
  const ids = sessionsByWebContentsId.get(webContentsId);
  if (!ids) return;
  for (const id of [...ids]) {
    if (!detachPrimarySession(id)) disposeSession(id);
  }
  sessionsByWebContentsId.delete(webContentsId);
}

function disposeSessionsFor(webContentsId: number): void {
  const ids = sessionsByWebContentsId.get(webContentsId);
  if (!ids) return;
  for (const id of [...ids]) disposeSession(id);
  sessionsByWebContentsId.delete(webContentsId);
}

function safeSend(
  webContents: WebContents,
  channel: string,
  payload: unknown,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

// Headless core command API, hosted in the main process (see
// /docs/design-decisions.md "Brain placement"). `HARBORMASTER_STATE_DIR` lets
// e2e tests point this at a fresh tmpdir per run instead of the real
// per-user state dir; unset in normal app use, where `createCore` falls back
// to its own default (`~/.harbormaster`).
const activeStateDir = process.env.HARBORMASTER_STATE_DIR ?? DEFAULT_STATE_DIR;

// Isolate Electron's own profile (localStorage with the sidebar's persisted
// width/collapse, window state, caches) the same way: without this, e2e runs
// share the developer's real profile and a crashed run can leave the rail
// collapsed for every later run, and for the developer.
if (process.env.HARBORMASTER_USER_DATA_DIR) {
  app.setPath("userData", process.env.HARBORMASTER_USER_DATA_DIR);
}
// Core's `git`/`gh` child processes spawn in a utility process, never on
// this event loop (see spawn-host-client.ts). Installed before the core is
// created; a run issued before app-ready (none today) spawns in-process.
const spawnHost = createSpawnHostRunner({
  fork: () =>
    app.isReady()
      ? utilityProcess.fork(join(__dirname, "spawn-host.js"), [], {
          serviceName: "harbormaster-spawn-host",
          stdio: "inherit",
        })
      : undefined,
  fallback: execFileRunner,
});
setProcessRunner(spawnHost.run);
app.on("will-quit", () => spawnHost.dispose());

const core = createCore({ stateDir: activeStateDir });

// The Pi harness adapter: builds pane launch specs and reads presence. Core
// never spawns processes itself (accessor separation) — this is the only
// place main talks to it, and it only ever calls `buildLaunchSpec`/
// `presence`, never the presence access layer directly.
const harness = new PiHarnessAdapter({ stateDir: activeStateDir });

/** Every task across every board column, flattened (groups carry no ordering meaning here). */
function flattenTasks(columns: BoardColumn[]): Task[] {
  return columns.flatMap((column) =>
    column.groups.flatMap((group) => group.tasks),
  );
}

/**
 * Actually starts one claimed launch's background pty (wave-2 task brief
 * point 1): shares the exact launch-spec resolution the renderer-driven
 * `pty:create` primary path uses (`resolvePrimaryLaunch`), so a background
 * launch resumes/forks/news the same conversation a manual open would. A
 * task whose binding has no worktree yet, or whose harness command is
 * missing, is logged and left alone with a `lastError` "-" background
 * launches never fall back to a shell. Resolves `true` only once the pty
 * actually exists (registered as the task's primary, so a pane opened from
 * here on attaches to it instead of spawning a second pi).
 */
async function startBackgroundLaunch(taskId: string): Promise<boolean> {
  const resolution = await resolvePrimaryLaunch(
    taskId,
    activeStateDir,
    core.commands,
    harness,
  );
  if (!resolution.binding?.worktreePath) {
    console.error(
      `[background-launcher] task ${taskId} has no worktree to launch in`,
    );
    await core.commands
      .updateTaskState(taskId, {
        lastError: "Launch failed: no worktree is bound to this task yet.",
      })
      .catch(() => {});
    return false;
  }
  if (resolution.commandMissing || !resolution.spec) {
    console.error(
      `[background-launcher] task ${taskId}: harness command not found; refusing to fall back to a shell for a background launch`,
    );
    await core.commands
      .updateTaskState(taskId, {
        lastError: "Launch failed: the pi command could not be found on PATH.",
      })
      .catch(() => {});
    return false;
  }
  createBackgroundPrimarySession(taskId, resolution.spec, (_exitCode) => {
    void pollPresenceOnce();
    void backgroundLauncher.runPass();
  });
  return true;
}

/**
 * A launched task's background pty just started: every window adds it to
 * its sidebar rail (attached, never focused; see App.tsx's
 * `onTaskLaunched`). Pushed only after the pty exists, so the pane the
 * renderer mounts attaches to it rather than racing it with a second pi.
 */
function broadcastTaskLaunched(taskId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, "app:task-launched", taskId);
  }
}

const backgroundLauncher = createBackgroundLauncher({
  listStartedLaunches: async () =>
    flattenTasks(await core.commands.listBoard()).filter(
      (task) => task.launch?.status === "started",
    ),
  getLaunchSettings: () => core.commands.getLaunchSettings(),
  hasLivePane: (taskId) => Boolean(lookupPanePid(taskId)),
  getPresence: async (taskId) => {
    const status = await harness.presence(taskId);
    return {
      runningTurn: status.runningTurn,
      hasPresenceRecord: status.record !== undefined,
      live: status.live,
    };
  },
  listPendingMessageTargets: async () => {
    const [ids, columns] = await Promise.all([
      core.commands.listTasksWithPendingMessages(),
      core.commands.listBoard(),
    ]);
    const byId = new Map(flattenTasks(columns).map((task) => [task.id, task]));
    return ids.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  },
  claimPendingLaunches: (limit) => core.commands.claimPendingLaunches(limit),
  startSession: async (task) => {
    if (await startBackgroundLaunch(task.id)) broadcastTaskLaunched(task.id);
  },
  // A message target with no live session resumes through the very same
  // path a launch uses (task-messaging decision 5). A wake is not a launch:
  // it never opens a rail row.
  wakeSession: async (taskId) => {
    await startBackgroundLaunch(taskId);
  },
  onStartError: (task, error) => {
    console.error(
      `[background-launcher] starting task ${task.id} failed:`,
      error,
    );
  },
});

function registerCoreIpc(): void {
  ipcMain.handle("core:listBoard", () => {
    // A window that fetched the board itself may now hold a snapshot newer
    // than the last push; never let the watcher's unchanged-board skip
    // (see `pushBoardToWindows`) suppress the next push against it.
    lastPushedBoardJson = undefined;
    return core.commands.listBoard();
  });
  ipcMain.handle("core:getTask", (_event, id: string) =>
    core.commands.getTask(id),
  );
  ipcMain.handle("core:createTask", (_event, input: CreateTaskInput) =>
    core.commands.createTask(input),
  );
  ipcMain.handle("core:listRepositories", () =>
    core.commands.listRepositories(),
  );
  ipcMain.handle("core:getTaskWorkspace", (_event, taskId: string) =>
    core.commands.getTaskWorkspace(taskId),
  );
  ipcMain.handle(
    "core:moveTask",
    (
      _event,
      id: string,
      state: TaskState,
      options: MoveTaskOptions | undefined,
    ) => core.commands.moveTask(id, state, options),
  );
  ipcMain.handle("core:listAwaitingKinds", (_event, taskId?: string) =>
    core.commands.listAwaitingKinds(taskId),
  );
  ipcMain.handle(
    "core:toAwait",
    (
      _event,
      taskId: string,
      kindId: AwaitingKindId,
      options: ToAwaitOptions | undefined,
    ) => core.commands.toAwait(taskId, kindId, options),
  );
  ipcMain.handle("core:startTask", (_event, taskId: string) =>
    core.commands.startTask(taskId),
  );
  // Main owns the ptys, so it (not the renderer) supplies the live pane
  // cwds core must never remove a worktree out from under.
  ipcMain.handle(
    "core:toDone",
    (_event, taskId: string, options: { force?: ToDoneForce } | undefined) => {
      // A closed tab's warm pi still runs in the worktree; end it so its cwd
      // doesn't land in protectedPaths and block the cleanup below.
      warmSessions.disposeForTask(taskId);
      return core.commands.toDone(taskId, {
        protectedPaths: activeSessionCwds(),
        ...(options?.force
          ? {
              force: {
                removeDirty: options.force.removeDirty === true,
                deleteUnmerged: options.force.deleteUnmerged === true,
              },
            }
          : {}),
      });
    },
  );
  ipcMain.handle(
    "core:reopenTask",
    (_event, taskId: string, input: ReopenTaskInput | undefined) =>
      core.commands.reopenTask(taskId, input),
  );
  // The one launch primitive (see /docs/design-decisions.md "Launching tasks from an agent"): creates a
  // task and queues it for the background launcher below. Wave 3's launch
  // dialog calls this; it never starts a pty itself "-" `backgroundLauncher`
  // picks the queued task up on its next pass (triggered right after, so a
  // launch starts promptly instead of waiting for the next external trigger).
  ipcMain.handle("core:launchTask", async (_event, input: LaunchTaskInput) => {
    const task = await core.commands.launchTask(input);
    void backgroundLauncher.runPass();
    return task;
  });
  ipcMain.handle("core:listChildren", (_event, parentTaskId: string) =>
    core.commands.listChildren(parentTaskId),
  );
  ipcMain.handle("core:getLaunchSettings", () =>
    core.commands.getLaunchSettings(),
  );
  // Sidebar inline rename (Orca polish item 4): patches title (or any other
  // non-state field) and publishes the same `board-changed` event every
  // other mutation does "-" the board card picks up the new title through
  // the normal event flow, no extra plumbing needed here.
  ipcMain.handle(
    "core:updateTaskState",
    (_event, id: string, patch: UpdateTaskInput) =>
      core.commands.updateTaskState(id, patch),
  );
  // Goes through the same connectivity-loop state machine the automation
  // timer runs on (see connectivityLoop.runOnce below) so a manually-
  // triggered refresh (tests, the board's "g"/Refresh button) surfaces both
  // warnings and the offline/restored banner identically instead of only
  // returning warnings to this one caller.
  ipcMain.handle("core:refresh", async (): Promise<{ warnings: string[] }> => {
    const outcome = await connectivityLoop.runOnce();
    return { warnings: outcome.warnings };
  });
  ipcMain.handle(
    "core:presence",
    async (_event, taskId: string): Promise<PresenceSnapshot> => {
      const status = await harness.presence(taskId);
      const ownedByApp = status.record
        ? activeSessionPids().has(status.record.pid)
        : false;
      return {
        live: status.live,
        runningTurn: status.runningTurn,
        ...(status.record ? { record: status.record } : {}),
        ownedByApp,
      };
    },
  );

  // Task messaging (see /docs/task-messaging.md "App"): the approval inbox's
  // commands. Each mutation pushes fresh messaging state to every window
  // right away (the state-file watcher would only catch it ~150ms later).
  ipcMain.handle("core:listPendingApprovals", () => {
    messagingPusher.invalidate();
    return core.commands.listPendingApprovals();
  });
  ipcMain.handle("core:getMessagingStates", () => {
    messagingPusher.invalidate();
    return core.commands.getMessagingStates();
  });
  ipcMain.handle(
    "core:approveMessage",
    async (
      _event,
      messageId: string,
      edits?: { text?: string; mode?: MessageMode },
    ) => {
      try {
        return await core.commands.approveMessage(messageId, edits);
      } finally {
        void messagingPusher.push();
        void backgroundLauncher.runPass();
      }
    },
  );
  ipcMain.handle("core:rejectMessage", async (_event, messageId: string) => {
    try {
      return await core.commands.rejectMessage(messageId);
    } finally {
      void messagingPusher.push();
    }
  });
  ipcMain.handle(
    "core:readMessageAttachment",
    (_event, messageId: string, index: number) =>
      core.commands.readMessageAttachment(messageId, index),
  );
  ipcMain.handle("core:listMessages", (_event, filter?: { taskId?: string }) =>
    core.commands.listMessages(filter),
  );

  // Push channel: forward every core event to every live window. `safeSend`
  // guards against sending to a webContents destroyed mid-flight (window
  // closed, app quitting) — same guard the pty IPC uses above.
  core.events.on("board-changed", (payload) => {
    pushBoardToWindows(payload.columns, { force: true });
    // A board change can mean a launch was just queued (or a launched
    // task's slot just freed up elsewhere) "-" see
    // background-launcher.ts's "on every core 'board-changed' event" trigger.
    void backgroundLauncher.runPass();
  });

  // In-process message writes (send/approve/claim here) announce themselves;
  // the extension's writes arrive through `watchMessagingFiles` instead.
  core.events.on("messages-changed", () => {
    void messagingPusher.push();
    // A pending message may have a target to wake.
    void backgroundLauncher.runPass();
  });

  // External writers share the state files with this process: the pi
  // extension's /todev//toawait//todone and the migration CLI write through
  // their own core instances, which emit events only in *their* process.
  // Watch the state files and republish a fresh board so in-session commands
  // reflect here in ~moments instead of on the next 30s refresh tick
  // (the missing half of the design's "frontends never poll files" rule).
  watchStateFiles();
  watchMessagingFiles();
}

// What the approval inbox and the task chips render: awaiting-approval
// messages plus derived per-task messaging state. Pushed on every change
// (deduped, see messaging-push.ts); a window that fetches it itself
// invalidates the dedupe so it is never skipped against a snapshot that
// window may not hold.
const messagingPusher = createDedupedPusher<MessagingChangedPayload>({
  load: async () => {
    const [approvals, states] = await Promise.all([
      core.commands.listPendingApprovals(),
      core.commands.getMessagingStates(),
    ]);
    return { approvals, states };
  },
  send: (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win.webContents, "core:messaging-changed", payload);
    }
  },
  onError: () => {
    // A half-written messages.json mid-atomic-rename can fail a read; the
    // next change (the rename completing) pushes again.
  },
});

let messagingWatchDebounce: ReturnType<typeof setTimeout> | undefined;
/**
 * The pi extension (and any other core instance) writes messages through
 * its own core, which never emits our `messages-changed` event: watch
 * `<stateDir>/messages` for `messages.json` and push + run a launcher pass
 * (a freshly pending message may need its target woken). The doorbell and
 * attachment subfolders change on every send/claim and are ignored.
 */
function watchMessagingFiles(): void {
  let watcher: FSWatcher;
  try {
    const messagesDir = resolveStatePaths(activeStateDir).messagesDir;
    mkdirSync(messagesDir, { recursive: true });
    watcher = watch(messagesDir, (_event, filename) => {
      if (!isMessagesLogChange(filename)) return;
      clearTimeout(messagingWatchDebounce);
      messagingWatchDebounce = setTimeout(() => {
        void messagingPusher.push();
        void backgroundLauncher.runPass();
      }, 150);
    });
  } catch {
    return;
  }
  app.on("before-quit", () => watcher.close());
}

// Serialized form of the last board pushed to windows. The state-file
// watcher fires for *every* write to tasks.json/workspace-bindings.json -
// this process's own mutations (already pushed through core's
// `board-changed` event) and an extension re-saving unchanged bindings
// mid-turn alike - and each push replaces the board wholesale in every
// renderer hook (App, Sidebar, Board, each TaskWorkspace), re-rendering the
// whole UI. Measured ~2-3 redundant pushes/s while an agent streams (see
// e2e/perf-flood.spec.ts); the watcher path skips a board identical to the
// last one pushed.
let lastPushedBoardJson: string | undefined;

function pushBoardToWindows(
  columns: BoardColumn[],
  options: { force?: boolean } = {},
): void {
  const json = JSON.stringify(columns);
  if (!options.force && json === lastPushedBoardJson) return;
  lastPushedBoardJson = json;
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, "core:board-changed", { columns });
  }
}

let stateWatchDebounce: ReturnType<typeof setTimeout> | undefined;
function watchStateFiles(): void {
  let watcher: FSWatcher;
  try {
    // A fresh install has no state dir until core's first write; watch()
    // throws ENOENT on a missing path and the watcher would never arm.
    mkdirSync(activeStateDir, { recursive: true });
    watcher = watch(activeStateDir, (_event, filename) => {
      if (!filename || !/^(tasks|workspace-bindings)\.json$/.test(filename)) {
        return;
      }
      clearTimeout(stateWatchDebounce);
      stateWatchDebounce = setTimeout(() => {
        void core.commands
          .listBoard()
          .then((columns) => pushBoardToWindows(columns))
          .catch(() => {
            // A half-written file mid-atomic-rename can fail a read; the next
            // watch event (the rename completing) retries.
          });
        // External writers (the pi extension's own launchTask calls, the
        // migration CLI) queue launches through their own core instance,
        // which never emits our `board-changed` event "-" this state-file
        // watcher push is this process's only signal that a new launch may
        // be waiting (see background-launcher.ts's matching trigger).
        void backgroundLauncher.runPass();
      }, 150);
    });
  } catch {
    return; // state dir may not exist yet on a totally fresh install
  }
  app.on("before-quit", () => watcher.close());
}

let presencePollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Presence pushes skip a window whose last push was identical (most ticks:
 * heartbeats are ~60s apart), sparing three renderer subscribers a
 * wholesale state replace + re-render every 5s. The renderer has no initial
 * presence fetch, so the dedupe is per window, reset when it (re)loads, and
 * an identical payload is still re-sent after 30s (see `createPushDedupe`).
 */
const presencePushDedupe = createPushDedupe({ maxSuppressMs: 30_000 });

let presencePoll: (() => Promise<void>) | undefined;

/**
 * Runs (or joins) a presence poll tick (`pollPresenceTick`), single-flighted:
 * the interval and pty-exit triggers never run it concurrently — a trigger
 * mid-tick schedules one trailing tick instead — and a failed tick is
 * logged, never an unhandled rejection.
 */
function pollPresenceOnce(): Promise<void> {
  presencePoll ??= createSingleFlight(pollPresenceTick, (error) => {
    console.error("[presence] poll failed:", error);
  });
  return presencePoll();
}

/**
 * One poll tick: presence for every non-done task, pushed as a single
 * taskId -> {live, runningTurn} map to every open window. Stops itself (and
 * is restarted by `startPresencePolling`) once no window is left open, so
 * exactly one timer ever runs regardless of window count.
 */
async function pollPresenceTick(): Promise<void> {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    stopPresencePolling();
    return;
  }
  const columns = await core.commands.listBoard();
  const tasks = columns
    .filter((column) => column.state !== "done")
    .flatMap((column) => column.groups.flatMap((group) => group.tasks));
  const entries = await Promise.all(
    tasks.map(async (task) => {
      const status = await harness.presence(task.id);
      // Outside-observation corroboration (see presence-corroboration.ts):
      // cross-checks the extension's self-reported record against the
      // app's own pane-pid registry before trusting its turn/outcome
      // semantics.
      const corroborated = corroboratePresence(status, lookupPanePid(task.id));
      const ended = corroborated.ended;
      return [
        task.id,
        {
          live: corroborated.live,
          runningTurn: corroborated.runningTurn,
          corroboration: corroborated.corroboration,
          ...(corroborated.heartbeatAt
            ? { heartbeatAt: corroborated.heartbeatAt }
            : {}),
          // Status + note only: `ended.notified` is main's own one-shot
          // bookkeeping (see access/session-presence-access.ts) and never
          // crosses the bridge.
          ...(ended
            ? {
                ended: {
                  status: ended.status,
                  ...(ended.note ? { note: ended.note } : {}),
                },
              }
            : {}),
          // Live self-reported done/blocked verdict (distinct from `ended`
          // "-" see `CorroboratedPresence.outcome`'s doc comment).
          ...(corroborated.outcome ? { outcome: corroborated.outcome } : {}),
        },
      ] as const;
    }),
  );
  const payload: PresenceChangedPayload = Object.fromEntries(entries);
  // Warm closed-tab sessions: remember who is mid-turn (never evicted), and
  // end any whose task left the active set (Done, deleted) so a merged
  // task's worktree cleanup isn't blocked by a lingering pi.
  workingTaskIds = new Set(
    entries.filter(([, p]) => p.runningTurn).map(([taskId]) => taskId),
  );
  warmSessions.reconcile(new Set(tasks.map((task) => task.id)));
  const json = JSON.stringify(payload);
  for (const win of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    if (!presencePushDedupe.shouldSend(win.webContents.id, json)) continue;
    safeSend(win.webContents, "core:presence-changed", payload);
  }
  // Launched tasks' working-ness can only change here between other
  // triggers (a turn started/ended with no board/pty-exit event of its
  // own) "-" see background-launcher.ts's "on each presence poll tick".
  void backgroundLauncher.runPass();
}

/**
 * Presence poll interval in milliseconds. Configurable via
 * `HARBORMASTER_PRESENCE_POLL_MS` so e2e tests can use a short interval
 * (e.g. 250ms) without changing production behaviour (default: 5000ms).
 */
const PRESENCE_POLL_MS = Math.max(
  100,
  Number(process.env.HARBORMASTER_PRESENCE_POLL_MS ?? 5_000),
);

function startPresencePolling(): void {
  if (presencePollTimer) return;
  presencePollTimer = setInterval(() => {
    void pollPresenceOnce();
  }, PRESENCE_POLL_MS);
  void pollPresenceOnce();
}

function stopPresencePolling(): void {
  if (!presencePollTimer) return;
  clearInterval(presencePollTimer);
  presencePollTimer = undefined;
}

// Last warning string pushed to windows, so an unbroken run of identical
// failures (a real gh/API error, never connectivity -- see below) never
// spams the same banner every tick -- only a changed (or newly-cleared)
// warning is pushed again.
let lastPushedRefreshWarning: string | undefined;

function pushRefreshWarning(warning: string | undefined): void {
  if (warning === lastPushedRefreshWarning) return;
  lastPushedRefreshWarning = warning;
  if (warning === undefined) return;
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, "core:refresh-warning", warning);
  }
}

// Last connectivity state pushed to windows, deduped the same way as
// refresh warnings: a long run of identical ticks (every offline poll, or
// every healthy 30s tick) never re-announces a state the renderer's banner
// is already showing.
let lastPushedConnectivityState: ConnectivityState | undefined;

function pushConnectivityState(state: ConnectivityState): void {
  if (state === lastPushedConnectivityState) return;
  lastPushedConnectivityState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, "core:connectivity", state);
  }
}

// One refresh: calls the core's refresh() (PR status + movers + archive
// sweep; see CoreCommands.refresh) and pushes any warning to every open
// window, deduped against the immediately preceding push. Connectivity-class
// failures (offline, DNS down, ...) never reach `warnings` -- core's
// refresh() already separates those into `result.connectivity` (see
// engines/connectivity.ts); this only has to forward that marker instead of
// ever turning it into a warning toast. refresh() itself never throws on a
// single task's PR failure, but a harder failure (gh entirely missing,
// config load failure, ...) can still reject the promise -- caught here so
// the single automation timer (see /AGENTS.md "Movers tick only in the
// app") never dies and keeps ticking regardless; a thrown connectivity-
// shaped message is classified the same way a per-task one would be.
// Shared by the connectivity loop and the `core:refresh` IPC handler, so a
// manually-triggered refresh pushes (and returns) warnings exactly the same
// way.
async function performRefresh(): Promise<{
  warnings: string[];
  connectivity?: { offline: true; failedChecks: number };
}> {
  try {
    // Live pane cwds: neither a mover-driven landing nor the done-cleanup
    // retry may remove a worktree a pane is still running in. Overlapping
    // calls (timer + manual `g`) are joined by core's single-flight refresh.
    const result = await core.commands.refresh({
      protectedPaths: activeSessionCwds(),
    });
    pushRefreshWarning(
      result.warnings.length > 0 ? result.warnings.join("; ") : undefined,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isConnectivityError(message)) {
      return { warnings: [], connectivity: { offline: true, failedChecks: 1 } };
    }
    console.error("[main] refresh failed:", error);
    pushRefreshWarning(message);
    return { warnings: [message] };
  }
}

// Drives the 30s/10s refresh cadence and the offline/reconnecting/restored
// banner state (see connectivity-loop.ts for the pure state machine this
// wires up). `net.isOnline()` is a fast local hint checked before any gh
// work: offline, every task's `gh` call is skipped outright instead of each
// failing individually with "check your internet".
const pruneGate = createIntervalGate(PRUNE_INTERVAL_MS);

/** Hourly message-attachment prune (task-messaging decision 12), riding the refresh loop; failures are logged, never thrown. */
function maybePruneMessageAttachments(): void {
  if (!pruneGate.tryAcquire()) return;
  core.commands.pruneMessageAttachments().catch((error: unknown) => {
    console.error("[main] message attachment prune failed:", error);
  });
}

const connectivityLoop = createConnectivityLoop({
  isOnline: () => net.isOnline(),
  performRefresh: async () => {
    maybePruneMessageAttachments();
    const result = await performRefresh();
    return { offline: Boolean(result.connectivity), warnings: result.warnings };
  },
  onStateChange: pushConnectivityState,
});

function startRefreshLoop(): void {
  connectivityLoop.start();
}

function stopRefreshLoop(): void {
  connectivityLoop.stop();
}

// Sleep/wake: a closed laptop lid stops both timers outright (no point
// polling presence or hammering gh while asleep) and restarts them ~3s
// after wake, since the network interface needs a beat to come back up --
// an immediate tick right on resume would just fail the same way it did
// before this feature existed. The real `suspend`/`resume` events are
// main-process-only and exercised for real only by hand (sleep the laptop);
// `wirePowerGating`'s state machine is what's unit-tested. Wired inside
// `app.whenReady()` below: `powerMonitor` is only usable once Electron is
// ready.
function wireSleepWakeGating(): void {
  wirePowerGating({
    onSuspend: (cb) => powerMonitor.on("suspend", cb),
    onResume: (cb) => powerMonitor.on("resume", cb),
    stopAll: () => {
      stopRefreshLoop();
      stopPresencePolling();
    },
    startAll: () => {
      startRefreshLoop();
      startPresencePolling();
    },
  });
}

// Wake / crash breadcrumbs in <userData>/logs/wake.log: power and lock
// events, renderer and GPU process exits, and the renderer's console errors
// plus `[terminal]` lines. Display trouble after sleep can't be reproduced
// in tests, so each real occurrence must leave evidence behind.
const wakeLog = createWakeLog(
  join(app.getPath("userData"), "logs", "wake.log"),
);

function wireWakeLog(): void {
  powerMonitor.on("suspend", () => wakeLog("power: suspend"));
  powerMonitor.on("resume", () => wakeLog("power: resume"));
  powerMonitor.on("lock-screen", () => wakeLog("power: lock-screen"));
  powerMonitor.on("unlock-screen", () => wakeLog("power: unlock-screen"));
  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU") wakeLog(`gpu-process-gone: ${details.reason}`);
  });
}

function registerPtyIpc(): void {
  ipcMain.handle(
    "pty:create",
    async (
      event,
      options: TerminalCreateOptions,
    ): Promise<TerminalCreateResult> => {
      const sender = event.sender;

      // Only a task workspace's first ("primary") panel ever runs pi, and
      // only when the task has a workspace binding (a worktree to run it
      // in); "+ terminal" panels and scratch tasks always get a plain
      // `$SHELL` in the same cwd (see AGENTS.md: harnesses are adapters,
      // core only ever hands back a launch spec "-" this is the one place
      // that spec is turned into a pty). Shared with the background
      // launcher (see primary-launch.ts) so a task launches identically
      // whichever path started it.
      const spec =
        options.primary && options.taskId
          ? (
              await resolvePrimaryLaunch(
                options.taskId,
                activeStateDir,
                core.commands,
                harness,
              )
            ).spec
          : undefined;

      const { id, fellBackToShell } = createSession(
        options.cols,
        options.rows,
        {
          onData: (data) => safeSend(sender, "pty:data", { id, data }),
          onExit: (exitCode) => {
            safeSend(sender, "pty:exit", { id, exitCode });
            untrackSession(sender.id, id);
            // Instant death: the pane-pid registry entry is already gone by
            // now (ptySessions drops it synchronously on the process's own
            // exit, ahead of this callback) "- re-run the full presence
            // computation right away instead of waiting out the ~5s poll
            // tick, so a task whose primary pane just died (or ended) shows
            // idle/ended immediately. `usePresenceMap` replaces its state
            // wholesale on every push, so this must recompute every task,
            // not just this one.
            if (options.primary && options.taskId) {
              void pollPresenceOnce();
              // A primary pty exiting frees a launch slot "-" see
              // background-launcher.ts's "on each ... pty exit" trigger.
              void backgroundLauncher.runPass();
            }
          },
        },
        {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(spec ? { spec } : {}),
          ...(options.taskId ? { taskId: options.taskId } : {}),
          ...(options.primary ? { primary: options.primary } : {}),
        },
      );
      // Tracked per webContents: if it is torn down before the renderer
      // calls `terminal.dispose()` (window force-closed, crashed, or the app
      // quits mid-session), `createWindow`'s single per-window 'destroyed'
      // listener disposes every pty it owns - no per-session listener (one
      // per spawn/attach piled up past MaxListeners across reloads).
      trackSession(sender.id, id);

      return { id, fellBackToShell };
    },
  );

  // Attach (wave-2 task brief point 4): the primary TerminalPane tries this
  // first. If the task has a live app-owned primary pty with no renderer
  // attached yet (a background launch nobody has opened), rebind its
  // data/exit callbacks to this webContents "-" same safeSend/track/
  // destroyed-cleanup semantics as `pty:create` "-" and return its
  // snapshot + pid. `undefined` when there is nothing to attach to (never
  // launched, already exited, or already attached); the renderer falls
  // back to `pty:create` exactly as it would for a task launched the
  // ordinary way. The takeover guard treats this as "ours" because
  // `core:presence`'s `ownedByApp` is already true the moment the
  // background session starts (it is in the same pane-pid registry a
  // renderer-launched primary uses) "-" it never shows the takeover dialog
  // for a paneless app-owned pty, and never spawns a second pi for the same
  // task.
  ipcMain.handle(
    "pty:attachPrimary",
    (
      event,
      taskId: string,
      cols: number,
      rows: number,
    ): { id: string; snapshot: string } | undefined => {
      const sender = event.sender;
      // `attachPrimarySession` resolves (and may deliver pty output) fully
      // synchronously from here, but the callbacks it's given need the
      // session id it's about to return "-" captured through this mutable
      // box instead of a forward reference to the not-yet-assigned result.
      const ref: { id: string } = { id: "" };
      const attached = attachPrimarySession(taskId, cols, rows, {
        onData: (data) => safeSend(sender, "pty:data", { id: ref.id, data }),
        onExit: (exitCode) => {
          safeSend(sender, "pty:exit", { id: ref.id, exitCode });
          untrackSession(sender.id, ref.id);
          void pollPresenceOnce();
          void backgroundLauncher.runPass();
        },
      });
      if (!attached) return undefined;
      ref.id = attached.id;
      // Reopened with a pane again: it is no longer a warm closed-tab session.
      warmSessions.forget(attached.id);
      // Same per-window 'destroyed' cleanup as `pty:create` (see there).
      trackSession(sender.id, attached.id);
      return { id: attached.id, snapshot: attached.snapshot };
    },
  );

  ipcMain.on("pty:write", (_event, id: string, data: string) => {
    writeToSession(id, data);
  });

  ipcMain.on("pty:resize", (_event, id: string, cols: number, rows: number) => {
    resizeSession(id, cols, rows);
  });

  // Flow control (see main/pty-data-batcher.ts): the pane acks each chunk
  // once xterm has parsed it.
  ipcMain.on("pty:ack", (_event, id: string, chars: number) => {
    acknowledgeSessionData(id, chars);
  });

  ipcMain.handle("pty:dispose", (event, id: string) => {
    untrackSession(event.sender.id, id);
    disposeSession(id);
  });

  // A pane closed by the user (tab close) releases its pty instead of
  // killing it: a task's primary goes back to the background (headless
  // screen mirror, same path as a window reload's `releaseSessionsFor`) so
  // reopening the tab re-attaches to the SAME pi instead of cold-starting a
  // new one (resume + MCP reconnect took several seconds), and closing the
  // tab of a working task no longer kills its agent mid-run. It stays
  // tracked to this webContents so the window's 'destroyed'/'closed' cleanup
  // (and app quit) still disposes it. Everything that is not a task primary
  // ("+ terminal" shells, shell fallbacks) is disposed as before.
  ipcMain.handle("pty:release", (event, id: string, screen?: unknown) => {
    if (
      detachPrimarySession(id, typeof screen === "string" ? screen : undefined)
    ) {
      warmSessions.add(id);
      return;
    }
    untrackSession(event.sender.id, id);
    disposeSession(id);
  });

  ipcMain.handle("pty:exists", (_event, id: string) => Boolean(getSession(id)));
}

function createWindow(): void {
  // E2e runs on a developer's live desktop: park fixture windows far
  // offscreen so a human can't wander into a throwaway instance and "use" it
  // (it happened — a real task was typed into a test window's fake board).
  const offscreen = Boolean(process.env.HARBORMASTER_WINDOW_OFFSCREEN);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // focusable:false matters as much as the position: an offscreen window
    // that takes key focus swallows the developer's real keystrokes into
    // test fixtures (observed: stray typed chars inside an e2e task title).
    // Playwright input is CDP-synthetic and needs no OS focus.
    ...(offscreen
      ? { x: -4200, y: -4200, skipTaskbar: true, focusable: false }
      : {}),
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Capture the id up front: by the time 'closed' fires, `win.webContents`
  // may already be destroyed/inaccessible.
  const webContentsId = win.webContents.id;

  if (offscreen) {
    // Test mode is fully invisible, not just off to the side: macOS may
    // clamp an offscreen window back onto the screen. Opacity 0 keeps it
    // composited (frames, rAF, screenshots all work) but unseen, and
    // ignoring mouse events stops an invisible window eating real clicks.
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
  }
  win.once("ready-to-show", () =>
    offscreen ? win.showInactive() : win.show(),
  );
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Cmd+W (mac) or Ctrl+W (other) closes the focused task workspace, not the
  // window.  Using `isCloseTabChord` scopes Ctrl+W to mac-only for pty
  // (delete-word-backward) — it must not be intercepted on darwin.
  win.webContents.on("before-input-event", (event, input) => {
    if (isCloseTabChord(input, process.platform)) {
      event.preventDefault();
      safeSend(win.webContents, "app:close-tab", undefined);
      return;
    }
    // Sidebar keyboard cycling: Cmd+Shift+Up/Down on mac, Ctrl+Shift elsewhere.
    // Scoped to Cmd-only on darwin so Ctrl+Shift+Up/Down reaches the pty.
    if (isSidebarCycleChord(input, process.platform)) {
      event.preventDefault();
      const direction = input.key === "ArrowUp" ? "up" : "down";
      safeSend(win.webContents, "app:cycle-task", direction);
    }
  });

  // Navigation guard (checklist §0.7): prevent Chromium from navigating the
  // renderer to file:// URLs (e.g. when the user drops a Finder file onto
  // the window outside a handled drop zone).  Allow the dev-server URL.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  win.webContents.on("will-navigate", (navEvent, url) => {
    const current = win.webContents.getURL();
    if (url === current) return;
    if (rendererUrl && url.startsWith(rendererUrl)) return;
    navEvent.preventDefault();
  });

  // Dispose this window's ptys as soon as it closes, and (belt-and-
  // suspenders, deliberately redundant) when its webContents is destroyed
  // by any other route — so pty processes never outlive the window whose
  // panels owned them. Exactly one listener of each per window, however
  // many ptys it spawns or attaches (`disposeSessionsFor` is idempotent).
  win.on("closed", () => {
    disposeSessionsFor(webContentsId);
    presencePushDedupe.reset(webContentsId);
  });
  win.webContents.once("destroyed", () => disposeSessionsFor(webContentsId));

  // Every (re)load starts a renderer with empty presence state and no fetch
  // of its own: forget what this window was last sent and push right away.
  win.webContents.on("did-finish-load", () => {
    presencePushDedupe.reset(webContentsId);
    void pollPresenceOnce();
  });

  // A reload (dev full reload, Cmd+R) or a crashed renderer keeps this
  // webContents alive, so the per-window 'destroyed' cleanup never runs and
  // the panes' own unmount cleanup never ran either. Without this, every
  // reload spawned a second pi per task on the same session file while the
  // old one kept running invisibly.
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      releaseSessionsFor(webContentsId);
    }
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    wakeLog(`render-process-gone: ${details.reason}`);
    releaseSessionsFor(webContentsId);
  });
  win.webContents.on("console-message", (_event, level, message) => {
    if (isWakeLogWorthy(level, message)) wakeLog(`renderer: ${message}`);
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * The renderer's only way to open a link in the user's default browser (it
 * has no Node/shell access). Every URL is checked against the allowlist in
 * external-url.ts first (github.com, plus the GitHub Enterprise hosts of
 * discovered repositories); anything else resolves `false` and is never
 * handed to the OS.
 */
function registerShellIpc(): void {
  ipcMain.handle(
    "shell:openExternal",
    async (_event, url: unknown): Promise<boolean> => {
      if (!isAllowedExternalUrl(url)) {
        // Not github.com: allow a GitHub Enterprise host only when a
        // discovered repository actually lives there (looked up on demand).
        const repositories = await core.commands
          .listRepositories()
          .catch(() => []);
        const hosts = githubHostsFromRepositoryIds(
          repositories.map((repo) => repo.id),
        );
        if (!isAllowedExternalUrl(url, hosts)) return false;
      }
      try {
        await shell.openExternal(url);
        return true;
      } catch (error) {
        console.error("[main] shell.openExternal failed:", error);
        return false;
      }
    },
  );

  // "Reveal in Finder" (Orca polish item 6 context menu): same allowlist
  // shape as openExternal above, but for local paths "-" only a worktree
  // path under the configured codeRoot, or anything under this app's own
  // state dir, is ever handed to the OS file manager (see reveal-path.ts).
  ipcMain.handle(
    "shell:revealInFolder",
    async (_event, targetPath: unknown): Promise<boolean> => {
      // No direct `codeRoot` getter on the command API; derive the allowed
      // roots from discovered repositories instead "-" each repo's own
      // checkout, plus its parent (the code root worktrees live next to,
      // at `<codeRoot>/.harbormaster-worktrees/`), plus this app's state
      // dir (session files, etc).
      const repositories = await core.commands
        .listRepositories()
        .catch(() => []);
      const roots = [
        activeStateDir,
        ...repositories.flatMap((repo) => [repo.root, dirname(repo.root)]),
      ];
      if (!isAllowedRevealPath(targetPath, roots)) return false;
      shell.showItemInFolder(targetPath);
      return true;
    },
  );
}

/**
 * OS notifications + dock badge (daily-driver switch, task B). The renderer
 * owns every bit of *when* decision logic (unread transitions, the
 * `harbormaster.notifications` localStorage escape hatch "- see
 * lib/unread.ts and lib/notifications.ts); main only ever displays what it
 * is told to, plus its own independent `HARBORMASTER_NOTIFICATIONS=off` kill
 * switch (so a notification can be silenced at the process level even if a
 * renderer bug ever called this anyway).
 */
function registerAppIpc(): void {
  ipcMain.handle(
    "app:notify",
    (event, payload: { taskId: string; title: string; body: string }): void => {
      // Logged unconditionally (ahead of every flag/support check) so e2e can
      // assert the renderer->main IPC fired without asserting real OS
      // notification display (Electron has no notification inspection API,
      // and CI machines often have no notification center at all).
      console.log(
        `[main] app:notify received: ${payload.taskId} ${JSON.stringify(payload.title)}`,
      );
      if (process.env.HARBORMASTER_NOTIFICATIONS === "off") return;
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
      });
      const senderId = event.sender.id;
      notification.on("click", () => {
        const win = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.id === senderId,
        );
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        // Same pattern as `app:cycle-task`: main only ever pushes the taskId,
        // the renderer's existing guarded `selectTask` path does the rest.
        safeSend(win.webContents, "app:open-task", payload.taskId);
      });
      notification.show();
    },
  );

  ipcMain.handle("app:setBadgeCount", (_event, count: unknown): void => {
    if (process.platform !== "darwin") return;
    const safeCount = typeof count === "number" && count > 0 ? count : 0;
    app.dock?.setBadge(safeCount > 0 ? String(safeCount) : "");
  });

  // P1-1: screen-reader mode IPC.
  // screenReaderMode is off by default (P1-1
  // It is enabled when (a) the OS reports an AT via app.isAccessibilitySupportEnabled(),
  // or (b) the HARBORMASTER_TERMINAL_A11Y_MIRROR=1 env var is set (e2e).
  const forceA11yMirror = process.env.HARBORMASTER_TERMINAL_A11Y_MIRROR === "1";

  ipcMain.handle(
    "terminal:screen-reader-mode",
    (): boolean => forceA11yMirror || app.isAccessibilitySupportEnabled(),
  );

  app.on("accessibility-support-changed", (_e, enabled: boolean) => {
    const value = forceA11yMirror || enabled;
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win.webContents, "terminal:screen-reader-mode-changed", value);
    }
  });
}

registerCoreIpc();
registerPtyIpc();
registerShellIpc();
registerAppIpc();
registerTerminalHostIpc();

app.whenReady().then(() => {
  // Test mode: no dock icon per e2e instance (see createWindow).
  if (process.env.HARBORMASTER_WINDOW_OFFSCREEN) app.dock?.hide();
  createWindow();
  startPresencePolling();
  startRefreshLoop();
  wireSleepWakeGating();
  wireWakeLog();
  // Queued launches (from a previous run, or an extension launchTask call
  // that landed before this app ever started) start right away "-" see
  // background-launcher.ts's "on app ready" trigger.
  void backgroundLauncher.runPass();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    startPresencePolling();
    startRefreshLoop();
  });
});

app.on("window-all-closed", () => {
  stopPresencePolling();
  stopRefreshLoop();
  if (process.platform !== "darwin") {
    // Real quit: route through `before-quit` below so the mid-turn
    // interrupt sweep runs before any pty (including a background launch's)
    // is disposed "-" `app.quit()` fires `before-quit` synchronously before
    // this handler returns.
    app.quit();
    return;
  }
  // Mac: the app keeps running with no window (dock icon stays); this
  // matches the app's pre-existing "no pane left open, nothing to show it
  // in" behavior for every session, background launches included. Mid-turn
  // launches are marked interrupted first, exactly like a real quit.
  void interruptMidTurnLaunches()
    .catch(() => {})
    .finally(() => disposeAllSessions());
});

/**
 * Races a promise against a timeout, resolving `undefined` instead of
 * hanging the quit path forever on a core call that never settles.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), ms);
    }),
  ]);
}

/**
 * Marks every launched task that is mid-turn right now `interrupted` (wave-2
 * task brief point 5), attached or not "-" ahead of `disposeAllSessions()`
 * killing every pty on quit. Bounded to ~2s (`withTimeout`) so a slow/stuck
 * core call never hangs app quit indefinitely; a timed-out or failed sweep
 * just means the next run's tasks stay `started` instead of `interrupted`
 * (core only ever flips `queued` -> `started` on its own, so this never
 * causes a double-launch "-" at worst a stale `started` that a later manual
 * check corrects).
 */
async function interruptMidTurnLaunches(): Promise<void> {
  await withTimeout(
    (async () => {
      const columns = await core.commands.listBoard();
      const started = flattenTasks(columns).filter(
        (task) => task.launch?.status === "started",
      );
      const midTurnIds: string[] = [];
      for (const task of started) {
        const status = await harness.presence(task.id).catch(() => undefined);
        if (status?.runningTurn) midTurnIds.push(task.id);
      }
      if (midTurnIds.length > 0) {
        await core.commands.markLaunchesInterrupted(midTurnIds);
      }
    })(),
    2_000,
  );
}

let quitting = false;
app.on("before-quit", (event) => {
  // `app.quit()` below re-fires this same event; let that second pass
  // through once the interrupt sweep (and the ptys it depends on) is done.
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void interruptMidTurnLaunches()
    .catch((error) => {
      console.error(
        "[main] interruptMidTurnLaunches failed (quitting anyway):",
        error,
      );
    })
    .finally(() => {
      disposeAllSessions();
      app.quit();
    });
});
