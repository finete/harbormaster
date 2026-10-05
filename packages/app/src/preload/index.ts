// Preload script — runs in a sandboxed, isolated context. It exposes only
// the narrow typed `window.harbormaster` API; the renderer never gets
// `require`, `process`, or any other Node global.
import { contextBridge, ipcRenderer } from "electron";
import type {
  HarbormasterApi,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
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
};

contextBridge.exposeInMainWorld("harbormaster", api);
