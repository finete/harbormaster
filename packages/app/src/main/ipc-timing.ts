// One wrapper around every `ipcMain.handle` handler: patched onto the
// `ipcMain` object once, before any handler registers (main/index.ts), so
// every module's handlers are covered without touching each call site.
// It tracks which channels are in flight right now (for `[health] spike`
// lines) and logs `[ipc] slow <channel> ms=…` for a handler slower than
// `slowMs`; faster calls go to `debugLog` (`HARBORMASTER_LOG=debug`).
// Channel names and durations only — never arguments or results.
import { debugLog } from "./debug-log";

export const IPC_SLOW_MS = 200;

/** `[ipc] slow <channel> ms=<ms>[ failed=true]` */
export function formatSlowIpcLine(
  channel: string,
  ms: number,
  failed = false,
): string {
  return `[ipc] slow ${channel} ms=${Math.round(ms)}${failed ? " failed=true" : ""}`;
}

// biome-ignore lint/suspicious/noExplicitAny: mirrors Electron's own `ipcMain.handle` listener signature.
type Handler = (event: any, ...args: any[]) => unknown;

export interface IpcHandleTarget {
  handle(channel: string, listener: Handler): void;
}

export interface IpcTiming {
  /** Channels with a handler running right now, `channel×n` when more than one call is in flight. */
  inFlight(): string[];
  /** Wraps one handler (exported for tests; `install` applies it to every registration). */
  wrap(channel: string, handler: Handler): Handler;
  /** Patches `target.handle` so every later registration is wrapped. Idempotent per target. */
  install(target: IpcHandleTarget): void;
}

const PATCHED = Symbol.for("harbormaster.ipcTimingPatched");

export function createIpcTiming(
  options: {
    now?: () => number;
    log?: (line: string) => void;
    debug?: (line: string) => void;
    slowMs?: number;
  } = {},
): IpcTiming {
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const debug = options.debug ?? ((line: string) => debugLog("ipc", line));
  const slowMs = options.slowMs ?? IPC_SLOW_MS;
  const counts = new Map<string, number>();

  function done(channel: string, start: number, failed: boolean): void {
    const n = (counts.get(channel) ?? 1) - 1;
    if (n <= 0) counts.delete(channel);
    else counts.set(channel, n);
    const ms = now() - start;
    if (ms > slowMs) log(formatSlowIpcLine(channel, ms, failed));
    else debug(`${channel} ms=${Math.round(ms)}${failed ? " failed" : ""}`);
  }

  function wrap(channel: string, handler: Handler): Handler {
    return async (event, ...args) => {
      counts.set(channel, (counts.get(channel) ?? 0) + 1);
      const start = now();
      try {
        const result = await handler(event, ...args);
        done(channel, start, false);
        return result;
      } catch (error) {
        done(channel, start, true);
        throw error;
      }
    };
  }

  function install(target: IpcHandleTarget): void {
    const marked = target as IpcHandleTarget & { [PATCHED]?: true };
    if (marked[PATCHED]) return;
    marked[PATCHED] = true;
    const original = target.handle.bind(target);
    target.handle = (channel, listener) =>
      original(channel, wrap(channel, listener));
  }

  return {
    inFlight: () =>
      [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([channel, n]) => (n > 1 ? `${channel}×${n}` : channel)),
    wrap,
    install,
  };
}

/** The app-wide instance main/index.ts installs on `ipcMain`. */
export const ipcTiming = createIpcTiming();
