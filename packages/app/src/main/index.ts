// Electron main process entry — see /AGENTS.md for the fixed UI stack.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type {
  AwaitingKindId,
  BoardColumn,
  CreateTaskInput,
  LaunchTaskInput,
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
  isConnectivityError,
  PiHarnessAdapter,
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
} from "electron";
import type {
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
import { wirePowerGating } from "./power-gating";
import { corroboratePresence } from "./presence-corroboration";
import { resolvePrimaryLaunch } from "./primary-launch";
import {
  acknowledgeSessionData,
  activeSessionCwds,
  activeSessionPids,
  attachPrimarySession,
  createBackgroundPrimarySession,
  createSession,
  disposeAllSessions,
  disposeSession,
  getSession,
  lookupPanePid,
  resizeSession,
  writeToSession,
} from "./ptySessions";
import { isAllowedRevealPath } from "./reveal-path";
import { registerTerminalHostIpc } from "./terminal-host-ipc";

// Raise Chromium's WebGL context cap before the GPU process starts.
// By default Chromium evicts the oldest context once 16 are active; with many
// terminal panes that causes permanent DOM-renderer fallback (4-5
// VS Code uses the same flag; see https://github.com/microsoft/vscode/pull/285575
// Verified on Electron 33: 40 terminals lose 8 contexts instead of 24.
app.commandLine.appendSwitch("max-active-webgl-contexts", "32");

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
 * launches never fall back to a shell.
 */
async function startBackgroundLaunch(taskId: string): Promise<void> {
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
    return;
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
    return;
  }
  createBackgroundPrimarySession(taskId, resolution.spec, (_exitCode) => {
    void pollPresenceOnce();
    void backgroundLauncher.runPass();
  });
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
    };
  },
  claimPendingLaunches: (limit) => core.commands.claimPendingLaunches(limit),
  startSession: (task) => startBackgroundLaunch(task.id),
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
    (_event, taskId: string, options: { force?: ToDoneForce } | undefined) =>
      core.commands.toDone(taskId, {
        protectedPaths: activeSessionCwds(),
        ...(options?.force
          ? {
              force: {
                removeDirty: options.force.removeDirty === true,
                deleteUnmerged: options.force.deleteUnmerged === true,
              },
            }
          : {}),
      }),
  );
  ipcMain.handle(
    "core:reopenTask",
    (_event, taskId: string, input: ReopenTaskInput | undefined) =>
      core.commands.reopenTask(taskId, input),
  );
  // The one launch primitive (see ai/prds/task-launching.md): creates a
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

  // External writers share the state files with this process: the pi
  // extension's /todev//toawait//todone and the migration CLI write through
  // their own core instances, which emit events only in *their* process.
  // Watch the state files and republish a fresh board so in-session commands
  // reflect here in ~moments instead of on the next 30s refresh tick
  // (the missing half of the design's "frontends never poll files" rule).
  watchStateFiles();
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
 * One poll tick: presence for every non-done task, pushed as a single
 * taskId -> {live, runningTurn} map to every open window. Stops itself (and
 * is restarted by `startPresencePolling`) once no window is left open, so
 * exactly one timer ever runs regardless of window count.
 */
async function pollPresenceOnce(): Promise<void> {
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
  for (const win of windows) {
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
const connectivityLoop = createConnectivityLoop({
  isOnline: () => net.isOnline(),
  performRefresh: async () => {
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
      trackSession(sender.id, id);

      // Belt-and-suspenders: if this webContents is torn down before the
      // renderer calls `terminal.dispose()` (window force-closed, crashed,
      // or the app quits mid-session), kill the pty here instead of leaving
      // an orphan process or a listener racing a destroyed send target.
      sender.once("destroyed", () => {
        untrackSession(sender.id, id);
        disposeSession(id);
      });

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
      trackSession(sender.id, attached.id);
      sender.once("destroyed", () => {
        untrackSession(sender.id, attached.id);
        disposeSession(attached.id);
      });
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

  // Dispose this window's ptys as soon as it closes — ahead of (and
  // redundant with, deliberately) the per-session webContents 'destroyed'
  // listener — so pty processes never outlive the window whose panels
  // owned them.
  win.on("closed", () => disposeSessionsFor(webContentsId));

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
  createWindow();
  startPresencePolling();
  startRefreshLoop();
  wireSleepWakeGating();
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
