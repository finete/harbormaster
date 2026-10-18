/**
 * Shared context object passed to every terminal-host feature installer.
 * Ties together the live xterm Terminal, the container element, and a
 * write-to-pty callback so individual feature modules don't need to know
 * about the IPC plumbing.
 */
import type { Terminal } from "@xterm/xterm";

export interface HostContext {
  /** The live xterm Terminal instance. */
  terminal: Terminal;
  /** The DOM element xterm was opened into (the inner div, not the wrapper). */
  container: HTMLElement;
  /**
   * Write `data` to the pty.  No-op until a pty session id has been assigned
   * (the createTimer hasn't fired yet).  The caller owns deciding whether to
   * call `terminal.paste` vs `write`; this path is for raw pty writes only.
   */
  write: (data: string) => void;
  /** Whether this is the primary (pi) pane of a task workspace. */
  isPrimary: boolean;
  /** True when running on macOS. */
  isMac: boolean;
  /** Open the search bar (set by chunk H). */
  openSearch: () => void;
  /** Open the context menu at viewport coordinates (set by chunk I). */
  openContextMenu: (x: number, y: number) => void;
  /** Register an additional key handler for feature modules that add their own shortcuts. */
  registerKeyHandler: (
    fn: (e: KeyboardEvent) => boolean | undefined,
    priority: number,
  ) => void;
}

/** A disposable returned by each installer. */
export interface IDisposable {
  dispose(): void;
}

/** Combine multiple disposables into one. */
export function combineDisposables(...disposables: IDisposable[]): IDisposable {
  return {
    dispose() {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Ignore teardown errors.
        }
      }
    },
  };
}
