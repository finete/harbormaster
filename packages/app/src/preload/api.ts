// Shared type contracts for the narrow IPC surface exposed to the renderer.
// The renderer has no Node access; every call goes through these typed
// bridges in `index.ts`'s `contextBridge.exposeInMainWorld`.

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
}
