// Preload script — runs in a sandboxed, isolated context. It exposes only
// the narrow typed `window.harbormaster` API; the renderer never gets
// `require`, `process`, or any other Node global.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AttachPrimaryResult,
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  ConnectivityState,
  CreateTaskInput,
  HarbormasterApi,
  LaunchTaskInput,
  MessageMode,
  MessagingChangedPayload,
  MoveTaskOptions,
  PresenceChangedPayload,
  PresenceSnapshot,
  ReopenTaskInput,
  RepositoryInfo,
  Task,
  TaskMessage,
  TaskMessagingState,
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
import { createIdRouter } from "./pty-bus";

/**
 * One `ipcRenderer` listener per pty channel, fanned out by session id
 * (see pty-bus.ts): a chunk crosses the context bridge only to the pane(s)
 * subscribed to its session instead of once per open pane.
 */
function ipcChannelSubscriber<E>(
  channel: string,
): (dispatch: (event: E) => void) => () => void {
  return (dispatch) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: E): void =>
      dispatch(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const ptyData = createIdRouter<TerminalDataEvent>(
  ipcChannelSubscriber<TerminalDataEvent>("pty:data"),
);
const ptyExit = createIdRouter<TerminalExitEvent>(
  ipcChannelSubscriber<TerminalExitEvent>("pty:exit"),
);

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
    onData: (
      listener: (event: TerminalDataEvent) => void,
      id?: string,
    ): (() => void) => ptyData.on(listener, id),
    onExit: (
      listener: (event: TerminalExitEvent) => void,
      id?: string,
    ): (() => void) => ptyExit.on(listener, id),
    // P1-1: screen-reader mode (off by default; on when OS AT detected or e2e env set).
    getScreenReaderMode: (): Promise<boolean> =>
      ipcRenderer.invoke("terminal:screen-reader-mode"),
    onScreenReaderModeChanged: (
      cb: (enabled: boolean) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        enabled: boolean,
      ): void => cb(enabled);
      ipcRenderer.on("terminal:screen-reader-mode-changed", handler);
      return () =>
        ipcRenderer.removeListener(
          "terminal:screen-reader-mode-changed",
          handler,
        );
    },
    attachPrimary: (
      taskId: string,
      cols: number,
      rows: number,
    ): Promise<AttachPrimaryResult | undefined> =>
      ipcRenderer.invoke("pty:attachPrimary", taskId, cols, rows),
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
    launchTask: (input: LaunchTaskInput): Promise<Task> =>
      ipcRenderer.invoke("core:launchTask", input),
    listChildren: (parentTaskId: string): Promise<Task[]> =>
      ipcRenderer.invoke("core:listChildren", parentTaskId),
    getLaunchSettings: (): Promise<{
      maxConcurrent: number;
      defaultModel?: string;
    }> => ipcRenderer.invoke("core:getLaunchSettings"),
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
    listPendingApprovals: (): Promise<TaskMessage[]> =>
      ipcRenderer.invoke("core:listPendingApprovals"),
    approveMessage: (
      messageId: string,
      edits?: { text?: string; mode?: MessageMode },
    ): Promise<TaskMessage> =>
      ipcRenderer.invoke("core:approveMessage", messageId, edits),
    rejectMessage: (messageId: string): Promise<TaskMessage> =>
      ipcRenderer.invoke("core:rejectMessage", messageId),
    getMessagingStates: (): Promise<TaskMessagingState[]> =>
      ipcRenderer.invoke("core:getMessagingStates"),
    readMessageAttachment: (
      messageId: string,
      index: number,
    ): Promise<{ mimeType?: string; base64: string }> =>
      ipcRenderer.invoke("core:readMessageAttachment", messageId, index),
    listMessages: (filter?: { taskId?: string }): Promise<TaskMessage[]> =>
      ipcRenderer.invoke("core:listMessages", filter),
    onMessagingChanged: (
      listener: (payload: MessagingChangedPayload) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: MessagingChangedPayload,
      ): void => listener(payload);
      ipcRenderer.on("core:messaging-changed", handler);
      return () =>
        ipcRenderer.removeListener("core:messaging-changed", handler);
    },
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
