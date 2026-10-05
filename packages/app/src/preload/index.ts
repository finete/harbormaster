// Preload script — runs in a sandboxed, isolated context. It exposes only
// the narrow typed `window.harbormaster` API; the renderer never gets
// `require`, `process`, or any other Node global.
import { contextBridge, ipcRenderer } from "electron";
import type {
  BoardChangedPayload,
  BoardColumn,
  CreateTaskInput,
  HarbormasterApi,
  MoveTaskOptions,
  RepositoryInfo,
  Task,
  TaskState,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  WorkspaceBinding,
} from "./api";

const api: HarbormasterApi = {
  terminal: {
    create: (options: TerminalCreateOptions): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke("pty:create", options),
    write: (id: string, data: string): void => {
      ipcRenderer.send("pty:write", id, data);
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send("pty:resize", id, cols, rows);
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
  },
};

contextBridge.exposeInMainWorld("harbormaster", api);
