// Electron main process entry — see /AGENTS.md for the fixed UI stack.

import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type {
  CreateTaskInput,
  MoveTaskOptions,
  TaskState,
} from "@harbormaster/core";
import { createCore } from "@harbormaster/core";
import type { WebContents } from "electron";
import { app, BrowserWindow, ipcMain } from "electron";
import type {
  TerminalCreateOptions,
  TerminalCreateResult,
} from "../preload/api";
import {
  createSession,
  disposeAllSessions,
  disposeSession,
  getSession,
  resizeSession,
  writeToSession,
} from "./ptySessions";

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
const core = createCore(
  process.env.HARBORMASTER_STATE_DIR
    ? { stateDir: process.env.HARBORMASTER_STATE_DIR }
    : {},
);

function registerCoreIpc(): void {
  ipcMain.handle("core:listBoard", () => core.commands.listBoard());
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

  // Push channel: forward every core event to every live window. `safeSend`
  // guards against sending to a webContents destroyed mid-flight (window
  // closed, app quitting) — same guard the pty IPC uses above.
  core.events.on("board-changed", (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win.webContents, "core:board-changed", payload);
    }
  });
}

function registerPtyIpc(): void {
  ipcMain.handle(
    "pty:create",
    (event, options: TerminalCreateOptions): TerminalCreateResult => {
      const sender = event.sender;
      const { id } = createSession(
        options.cols,
        options.rows,
        {
          onData: (data) => safeSend(sender, "pty:data", { id, data }),
          onExit: (exitCode) => {
            safeSend(sender, "pty:exit", { id, exitCode });
            untrackSession(sender.id, id);
          },
        },
        options.cwd ? { cwd: options.cwd } : undefined,
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

      return { id };
    },
  );

  ipcMain.on("pty:write", (_event, id: string, data: string) => {
    writeToSession(id, data);
  });

  ipcMain.on("pty:resize", (_event, id: string, cols: number, rows: number) => {
    resizeSession(id, cols, rows);
  });

  ipcMain.handle("pty:dispose", (event, id: string) => {
    untrackSession(event.sender.id, id);
    disposeSession(id);
  });

  ipcMain.handle("pty:exists", (_event, id: string) => Boolean(getSession(id)));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
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

  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

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

registerCoreIpc();
registerPtyIpc();

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  disposeAllSessions();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  disposeAllSessions();
});
