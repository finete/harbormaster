// Shared type contracts for the narrow IPC surface exposed to the renderer.
// The renderer has no Node access; every call goes through these typed
// bridges in `index.ts`'s `contextBridge.exposeInMainWorld`.
//
// `@harbormaster/core` types are imported `type`-only here: fully erased at
// build time, so none of core's Node-dependent runtime code (fs, child
// processes, ...) ever ends up in the renderer's web bundle "- only its
// plain data shapes cross the bridge.
import type {
  BoardChangedPayload,
  BoardColumn,
  CreateTaskInput,
  MoveTaskOptions,
  Task,
  TaskState,
} from "@harbormaster/core";

export type {
  AwaitingKind,
  BoardChangedPayload,
  BoardColumn,
  BoardGroup,
  CreateTaskInput,
  MoveTaskOptions,
  Task,
  TaskState,
} from "@harbormaster/core";

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
}

export interface TerminalCreateResult {
  id: string;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
}

export interface HarbormasterApi {
  terminal: {
    create(options: TerminalCreateOptions): Promise<TerminalCreateResult>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    dispose(id: string): Promise<void>;
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    onExit(listener: (event: TerminalExitEvent) => void): () => void;
  };
  core: {
    listBoard(): Promise<BoardColumn[]>;
    getTask(id: string): Promise<Task | undefined>;
    createTask(input: CreateTaskInput): Promise<Task>;
    moveTask(
      id: string,
      state: TaskState,
      options?: MoveTaskOptions,
    ): Promise<Task>;
    /** Subscribes to the core's board-changed push channel; returns an unsubscribe fn. */
    onBoardChanged(
      listener: (payload: BoardChangedPayload) => void,
    ): () => void;
  };
}
