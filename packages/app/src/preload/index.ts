// Preload script — runs in a sandboxed, isolated context. It exposes only
// the narrow typed `window.harbormaster` API; the renderer never gets
// `require`, `process`, or any other Node global.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  ConnectivityState,
  CreateTaskInput,
  HarbormasterApi,
  MoveTaskOptions,
  PresenceChangedPayload,
  PresenceSnapshot,
  ReopenTaskInput,
  RepositoryInfo,
  Task,
  TaskState,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  ToAwaitOptions,
  ToDoneForce,
  ToDoneResult,
  UpdateTaskInput,
  WorkspaceBinding,
} from "./api";

const api: HarbormasterApi = {
  shell: {
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke("shell:openExternal", url),
    revealInFolder: (path: string): Promise<boolean> =>
      ipcRenderer.invoke("shell:revealInFolder", path),
  },
  terminal: {
    create: (options: TerminalCreateOptions): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke("pty:create", options),
    write: (id: string, data: string): void => {
      ipcRenderer.send("pty:write", id, data);
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send("pty:resize", id, cols, rows);
    },
    ack: (id: string, chars: number): void => {
      ipcRenderer.send("pty:ack", id, chars);
    },
    dispose: (id: string): Promise<void> =>
      ipcRenderer.invoke("pty:dispose", id),
    onData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalDataEvent,
      ): void => listener(payload);
      ipcRenderer.on("pty:data", handler);
      return () => ipcRenderer.removeListener("pty:data", handler);
    },
    onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalExitEvent,
      ): void => listener(payload);
      ipcRenderer.on("pty:exit", handler);
      return () => ipcRenderer.removeListener("pty:exit", handler);
    },
  },
  core: {
    listBoard: (): Promise<BoardColumn[]> =>
      ipcRenderer.invoke("core:listBoard"),
    getTask: (id: string): Promise<Task | undefined> =>
      ipcRenderer.invoke("core:getTask", id),
    listRepositories: (): Promise<RepositoryInfo[]> =>
      ipcRenderer.invoke("core:listRepositories"),
    getTaskWorkspace: (taskId: string): Promise<WorkspaceBinding | undefined> =>
      ipcRenderer.invoke("core:getTaskWorkspace", taskId),
    createTask: (input: CreateTaskInput): Promise<Task> =>
      ipcRenderer.invoke("core:createTask", input),
    moveTask: (
      id: string,
      state: TaskState,
      options?: MoveTaskOptions,
    ): Promise<Task> => ipcRenderer.invoke("core:moveTask", id, state, options),
    startTask: (taskId: string): Promise<Task> =>
      ipcRenderer.invoke("core:startTask", taskId),
    listAwaitingKinds: (taskId?: string): Promise<AwaitingKindOption[]> =>
      ipcRenderer.invoke("core:listAwaitingKinds", taskId),
    toAwait: (
      taskId: string,
      kindId: AwaitingKindId,
      options?: ToAwaitOptions,
    ): Promise<Task> =>
      ipcRenderer.invoke("core:toAwait", taskId, kindId, options),
    toDone: (
      taskId: string,
      options?: { force?: ToDoneForce },
    ): Promise<ToDoneResult> =>
      ipcRenderer.invoke("core:toDone", taskId, options),
    reopenTask: (
      taskId: string,
      input?: ReopenTaskInput,
    ): Promise<{ task: Task; warning?: string }> =>
      ipcRenderer.invoke("core:reopenTask", taskId, input),
    refresh: (): Promise<{ warnings: string[] }> =>
      ipcRenderer.invoke("core:refresh"),
    onBoardChanged: (
      listener: (payload: BoardChangedPayload) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: BoardChangedPayload,
      ): void => listener(payload);
      ipcRenderer.on("core:board-changed", handler);
      return () => ipcRenderer.removeListener("core:board-changed", handler);
    },
    presence: (taskId: string): Promise<PresenceSnapshot> =>
      ipcRenderer.invoke("core:presence", taskId),
    onPresenceChanged: (
      listener: (payload: PresenceChangedPayload) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: PresenceChangedPayload,
      ): void => listener(payload);
      ipcRenderer.on("core:presence-changed", handler);
      return () => ipcRenderer.removeListener("core:presence-changed", handler);
    },
    onRefreshWarning: (listener: (warning: string) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        warning: string,
      ): void => listener(warning);
      ipcRenderer.on("core:refresh-warning", handler);
      return () => ipcRenderer.removeListener("core:refresh-warning", handler);
    },
    onConnectivityChanged: (
      listener: (state: ConnectivityState) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: ConnectivityState,
      ): void => listener(state);
      ipcRenderer.on("core:connectivity", handler);
      return () => ipcRenderer.removeListener("core:connectivity", handler);
    },
    onCloseTabShortcut: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on("app:close-tab", handler);
      return () => ipcRenderer.removeListener("app:close-tab", handler);
    },
    updateTaskState: (id: string, patch: UpdateTaskInput): Promise<Task> =>
      ipcRenderer.invoke("core:updateTaskState", id, patch),
    onCycleTask: (
      listener: (direction: "up" | "down") => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        direction: "up" | "down",
      ): void => listener(direction);
      ipcRenderer.on("app:cycle-task", handler);
      return () => ipcRenderer.removeListener("app:cycle-task", handler);
    },
  },
  app: {
    notify: (input: {
      taskId: string;
      title: string;
      body: string;
    }): Promise<void> => ipcRenderer.invoke("app:notify", input),
    setBadgeCount: (count: number): Promise<void> =>
      ipcRenderer.invoke("app:setBadgeCount", count),
    onOpenTask: (listener: (taskId: string) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        taskId: string,
      ): void => listener(taskId);
      ipcRenderer.on("app:open-task", handler);
      return () => ipcRenderer.removeListener("app:open-task", handler);
    },
  },
  terminalHost: {
    resolveClipboardPaste: (): Promise<string | null> =>
      ipcRenderer.invoke("terminalHost:resolveClipboardPaste"),
    openLink: (url: string): Promise<boolean> =>
      ipcRenderer.invoke("terminalHost:openLink", url),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld("harbormaster", api);
