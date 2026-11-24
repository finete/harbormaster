// Preload script — runs in a sandboxed, isolated context. It exposes only
// the narrow typed `window.harbormaster` API; the renderer never gets
// `require`, `process`, or any other Node global.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AddonInfo,
  AttachPrimaryResult,
  AuditEntry,
  AwaitingKindId,
  AwaitingKindOption,
  BoardChangedPayload,
  BoardColumn,
  ConfigChangedPayload,
  ConnectivityState,
  CreateTaskActionInput,
  CreateTaskInput,
  DoctorReport,
  HarbormasterApi,
  HarnessDescriptorInfo,
  HarnessModelCatalog,
  ImportItemsInput,
  InboxItem,
  InboxPriorityInput,
  InstalledUpdate,
  KnownLocation,
  LaunchSettings,
  LaunchTaskInput,
  ListEventsFilter,
  ListImportCandidatesInput,
  ListSlashCommandsInput,
  MessageMode,
  MessagingChangedPayload,
  MoveTaskOptions,
  OnboardingApi,
  OpenInAppInfo,
  OpenInResult,
  OrphanWorktreeReport,
  PresenceChangedPayload,
  PresenceSnapshot,
  PullRequestPreview,
  PullRequestReference,
  ReadyToLandEntry,
  ReopenTaskInput,
  RepositoryInfo,
  ResolveInboxItemResult,
  ReviewRejectedPayload,
  ReviewRequestResult,
  ReviewSupport,
  RulesListing,
  SettingsPatch,
  SettingsSnapshot,
  SlashCommandCatalog,
  Task,
  TaskMessage,
  TaskMessagingState,
  TaskState,
  TaskUrlOpenedPayload,
  TaskUsage,
  TaskUsageQuery,
  TaskUsageRow,
  TaskWorkspace,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  ToAwaitOptions,
  ToDoneForce,
  ToDoneResult,
  UpdateInfo,
  UpdateTaskInput,
  WorktreeStatus,
} from "./api";
import { installFrameCookies } from "./frame-cookies";
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
    release: (id: string, screen?: string): Promise<void> =>
      ipcRenderer.invoke("pty:release", id, screen),
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
    listLocations: (): Promise<KnownLocation[]> =>
      ipcRenderer.invoke("core:listLocations"),
    addLocation: (path: string): Promise<KnownLocation> =>
      ipcRenderer.invoke("core:addLocation", path),
    listBranches: (repositoryId: string): Promise<string[]> =>
      ipcRenderer.invoke("core:listBranches", repositoryId),
    listModels: (): Promise<HarnessModelCatalog[]> =>
      ipcRenderer.invoke("core:listModels"),
    listSlashCommands: (
      input: ListSlashCommandsInput,
    ): Promise<SlashCommandCatalog> =>
      ipcRenderer.invoke("core:listSlashCommands", input),
    listHarnessDescriptors: (): Promise<HarnessDescriptorInfo[]> =>
      ipcRenderer.invoke("core:listHarnessDescriptors"),
    getTaskWorkspace: (taskId: string): Promise<TaskWorkspace | undefined> =>
      ipcRenderer.invoke("core:getTaskWorkspace", taskId),
    listWorktreeStatus: (): Promise<Record<string, WorktreeStatus>> =>
      ipcRenderer.invoke("core:listWorktreeStatus"),
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
    archiveTask: (
      taskId: string,
      options?: { force?: ToDoneForce },
    ): Promise<ToDoneResult> =>
      ipcRenderer.invoke("core:archiveTask", taskId, options),
    listImportCandidates: (input?: ListImportCandidatesInput) =>
      ipcRenderer.invoke("core:listImportCandidates", input),
    importItems: (input: ImportItemsInput) =>
      ipcRenderer.invoke("core:importItems", input),
    undoImport: (batchId: string) =>
      ipcRenderer.invoke("core:undoImport", batchId),
    removeExternalWorktree: (
      taskId: string,
      options?: { force?: ToDoneForce },
    ): Promise<ToDoneResult> =>
      ipcRenderer.invoke("core:removeExternalWorktree", taskId, options),
    retryDoneCleanup: (taskId: string): Promise<Task> =>
      ipcRenderer.invoke("core:retryDoneCleanup", taskId),
    abandonDoneCleanup: (taskId: string): Promise<Task> =>
      ipcRenderer.invoke("core:abandonDoneCleanup", taskId),
    reopenTask: (
      taskId: string,
      input?: ReopenTaskInput,
    ): Promise<{ task: Task; warning?: string }> =>
      ipcRenderer.invoke("core:reopenTask", taskId, input),
    refresh: (): Promise<{ warnings: string[] }> =>
      ipcRenderer.invoke("core:refresh"),
    scanOrphanWorktrees: (): Promise<OrphanWorktreeReport> =>
      ipcRenderer.invoke("core:scanOrphanWorktrees"),
    doctor: (): Promise<DoctorReport> => ipcRenderer.invoke("core:doctor"),
    launchTask: (input: LaunchTaskInput): Promise<Task> =>
      ipcRenderer.invoke("core:launchTask", input),
    listChildren: (parentTaskId: string): Promise<Task[]> =>
      ipcRenderer.invoke("core:listChildren", parentTaskId),
    setTaskParent: (
      taskId: string,
      parentTaskId: string | null,
    ): Promise<Task> =>
      ipcRenderer.invoke("core:setTaskParent", taskId, parentTaskId),
    listTaskUsage: (query?: TaskUsageQuery): Promise<TaskUsageRow[]> =>
      ipcRenderer.invoke("core:listTaskUsage", query),
    refreshTaskUsage: (taskId: string): Promise<TaskUsage | undefined> =>
      ipcRenderer.invoke("core:refreshTaskUsage", taskId),
    getLaunchSettings: (repositoryId?: string): Promise<LaunchSettings> =>
      ipcRenderer.invoke("core:getLaunchSettings", repositoryId),
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
    onRefreshed: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on("core:refreshed", handler);
      return () => ipcRenderer.removeListener("core:refreshed", handler);
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
      edits?: { text?: string; mode?: MessageMode; allowBothWays?: boolean },
    ): Promise<TaskMessage & { releasedCount?: number }> =>
      ipcRenderer.invoke("core:approveMessage", messageId, edits),
    revokePairGrant: (taskId: string, otherTaskId: string): Promise<void> =>
      ipcRenderer.invoke("core:revokePairGrant", taskId, otherTaskId),
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
    listInbox: (options?: {
      includeResolved?: boolean;
      includeSnoozed?: boolean;
    }): Promise<InboxItem[]> => ipcRenderer.invoke("core:listInbox", options),
    resolveInboxItem: (
      itemId: string,
      options?: { buttonId?: string; snoozeUntil?: string },
    ): Promise<ResolveInboxItemResult> =>
      ipcRenderer.invoke("core:resolveInboxItem", itemId, options),
    evaluateInboxPriority: (items: InboxPriorityInput[]): Promise<boolean[]> =>
      ipcRenderer.invoke("core:evaluateInboxPriority", items),
    listReadyToLand: (): Promise<ReadyToLandEntry[]> =>
      ipcRenderer.invoke("core:listReadyToLand"),
    createTaskFromAction: (input: CreateTaskActionInput): Promise<Task> =>
      ipcRenderer.invoke("core:createTaskFromAction", input),
    parsePullRequestUrl: (url: string): Promise<PullRequestReference | null> =>
      ipcRenderer.invoke("core:parsePullRequestUrl", url),
    previewPullRequest: (url: string): Promise<PullRequestPreview> =>
      ipcRenderer.invoke("core:previewPullRequest", url),
    listEvents: (filter?: ListEventsFilter): Promise<AuditEntry[]> =>
      ipcRenderer.invoke("core:listEvents", filter),
    rulesCheck: (input?: { taskId?: string; replayFrom?: string }) =>
      ipcRenderer.invoke("core:rulesCheck", input),
    listRules: (): Promise<RulesListing> =>
      ipcRenderer.invoke("core:listRules"),
    setRulesEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("core:setRulesEnabled", enabled),
    listAddons: (): Promise<AddonInfo[]> =>
      ipcRenderer.invoke("core:listAddons"),
    openTaskUrl: (input: {
      taskId: string;
      url: string;
      source?: "plannotator" | "browser";
    }): Promise<void> => ipcRenderer.invoke("core:openTaskUrl", input),
    requestReview: (input: {
      taskId: string;
      target?: "local" | "pr";
    }): Promise<ReviewRequestResult> =>
      ipcRenderer.invoke("core:requestReview", input),
    reviewSupport: (options?: { refresh?: boolean }): Promise<ReviewSupport> =>
      ipcRenderer.invoke("core:reviewSupport", options),
    setCaptureAgentBrowser: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("core:setCaptureAgentBrowser", enabled),
    getSettings: (): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke("core:getSettings"),
    updateSettings: (patch: SettingsPatch): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke("core:updateSettings", patch),
    onConfigChanged: (
      listener: (payload: ConfigChangedPayload) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: ConfigChangedPayload,
      ): void => listener(payload);
      ipcRenderer.on("core:config-changed", handler);
      return () => ipcRenderer.removeListener("core:config-changed", handler);
    },
    probeUrl: (url: string): Promise<boolean> =>
      ipcRenderer.invoke("app:probeUrl", url),
    countUnsentReviewComments: (url: string): Promise<number | null> =>
      ipcRenderer.invoke("app:countUnsentReviewComments", url),
    closeReviewSession: (url: string): Promise<boolean> =>
      ipcRenderer.invoke("app:closeReviewSession", url),
    onTaskUrlOpened: (
      listener: (payload: TaskUrlOpenedPayload) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: TaskUrlOpenedPayload,
      ): void => listener(payload);
      ipcRenderer.on("core:task-url-opened", handler);
      return () => ipcRenderer.removeListener("core:task-url-opened", handler);
    },
    onReviewRejected: (
      listener: (payload: ReviewRejectedPayload) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: ReviewRejectedPayload,
      ): void => listener(payload);
      ipcRenderer.on("core:review-rejected", handler);
      return () => ipcRenderer.removeListener("core:review-rejected", handler);
    },
    terminalTail: (taskId: string, count?: number): Promise<string | null> =>
      ipcRenderer.invoke("core:terminalTail", taskId, count),
    retryLaunch: (taskId: string): Promise<boolean> =>
      ipcRenderer.invoke("core:retryLaunch", taskId),
    onInboxChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on("core:inbox-changed", handler);
      return () => ipcRenderer.removeListener("core:inbox-changed", handler);
    },
  },
  app: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke("app:pickFolder"),
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
    onTaskLaunched: (listener: (taskId: string) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        taskId: string,
      ): void => listener(taskId);
      ipcRenderer.on("app:task-launched", handler);
      return () => ipcRenderer.removeListener("app:task-launched", handler);
    },
    getUpdate: (): Promise<UpdateInfo | null> =>
      ipcRenderer.invoke("app:getUpdate"),
    onUpdateAvailable: (
      listener: (update: UpdateInfo) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        update: UpdateInfo,
      ): void => listener(update);
      ipcRenderer.on("app:update-available", handler);
      return () => ipcRenderer.removeListener("app:update-available", handler);
    },
    getInstalledUpdate: (): Promise<InstalledUpdate | null> =>
      ipcRenderer.invoke("app:getInstalledUpdate"),
    onInstalledUpdate: (
      listener: (update: InstalledUpdate) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        update: InstalledUpdate,
      ): void => listener(update);
      ipcRenderer.on("app:installed-update", handler);
      return () => ipcRenderer.removeListener("app:installed-update", handler);
    },
    restartToUpdate: (): Promise<void> =>
      ipcRenderer.invoke("app:restartToUpdate"),
    copyText: (text: string): Promise<void> =>
      ipcRenderer.invoke("app:copyText", text),
    exportDiagnostics: (): Promise<string | null> =>
      ipcRenderer.invoke("app:exportDiagnostics"),
    saveTextFile: (defaultName: string, text: string): Promise<string | null> =>
      ipcRenderer.invoke("app:saveTextFile", defaultName, text),
    copyDiagnosticsSummary: (): Promise<string> =>
      ipcRenderer.invoke("app:copyDiagnosticsSummary"),
    openInApps: (): Promise<OpenInAppInfo[]> =>
      ipcRenderer.invoke("app:openInApps"),
    openIn: (path: string, appId: string): Promise<OpenInResult> =>
      ipcRenderer.invoke("app:openIn", path, appId),
    openConfigFile: (appId?: string): Promise<OpenInResult> =>
      ipcRenderer.invoke("app:openConfigFile", appId),
    onShowSettings: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on("app:show-settings", handler);
      return () => ipcRenderer.removeListener("app:show-settings", handler);
    },
    reportError: (error: {
      message: string;
      stack?: string | undefined;
      source?: string | undefined;
    }): void => {
      ipcRenderer.send("app:rendererError", error);
    },
    reportFrameStats: (stats: { long: number; maxMs: number }): void => {
      ipcRenderer.send("app:frameStats", stats);
    },
  },
  onboarding: {
    shouldShow: () => ipcRenderer.invoke("onboarding:shouldShow"),
    getState: () => ipcRenderer.invoke("onboarding:getState"),
    scanCodeRoot: (path) => ipcRenderer.invoke("onboarding:scanCodeRoot", path),
    setCodeRoot: (path, options) =>
      ipcRenderer.invoke("onboarding:setCodeRoot", path, options),
    detectAgents: () => ipcRenderer.invoke("onboarding:detectAgents"),
    setDefaultAgent: (input) =>
      ipcRenderer.invoke("onboarding:setDefaultAgent", input),
    githubAuthStatus: () => ipcRenderer.invoke("onboarding:githubAuthStatus"),
    setSourceEnabled: (sourceId, enabled) =>
      ipcRenderer.invoke("onboarding:setSourceEnabled", sourceId, enabled),
    ensureDefaultRules: () =>
      ipcRenderer.invoke("onboarding:ensureDefaultRules"),
    complete: () => ipcRenderer.invoke("onboarding:complete"),
  } satisfies OnboardingApi,
  terminalHost: {
    resolveClipboardPaste: (): Promise<string | null> =>
      ipcRenderer.invoke("terminalHost:resolveClipboardPaste"),
    openLink: (url: string): Promise<boolean> =>
      ipcRenderer.invoke("terminalHost:openLink", url),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  },
};

// This preload also runs in subframes (`nodeIntegrationInSubFrames`, for the
// URL pane's cookies: frame-cookies-shim.ts). Only the app's own top frame
// ever gets the API; an embedded page gets nothing but its cookie jar.
if (window.top === window) {
  contextBridge.exposeInMainWorld("harbormaster", api);
} else {
  installFrameCookies();
}
