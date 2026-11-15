// Persistent rotating main-process log: `<userData>/logs/main.log`. Every
// `console.log/info/warn/error` call in the main process is teed here (ISO
// timestamp + level prefix) in addition to going to stdout/stderr as
// before — a packaged, Dock-launched app has no terminal to read those
// from, so without this file a real bug (see AGENTS.md task brief) leaves
// no trace at all.
//
// Pure helpers (`formatLogLine`, `shouldRotate`, `rotatedPath`,
// `rotationRenames`) are unit-tested without touching disk; `createAppLog`
// wires them to an injectable, promise-based `fs` so the hot path never
// blocks the event loop on a sync write and a logging failure can never
// throw past the caller (logging must never break the app).
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogDedupe } from "./log-dedupe";
import { redactLogLine } from "./log-redact";

/** Rotate once a log file exceeds this size. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Keep this many rotated backups (`main.1.log` … `main.3.log`) besides the live file. */
export const MAX_LOG_BACKUPS = 3;

export type LogLevel = "log" | "info" | "warn" | "error";

/** One argument of a tee'd console call, turned into readable text. */
export function stringifyLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One formatted line: `<ISO timestamp> [<LEVEL>] <args joined by space>`, no trailing newline. */
export function formatLogLine(
  level: LogLevel,
  args: readonly unknown[],
  now: Date = new Date(),
): string {
  const message = args.map(stringifyLogArg).join(" ");
  return `${now.toISOString()} [${level.toUpperCase()}] ${message}`;
}

/** Whether a file this size should rotate before the next append. */
export function shouldRotate(
  sizeBytes: number,
  maxBytes: number = MAX_LOG_BYTES,
): boolean {
  return sizeBytes > maxBytes;
}

/** `basePath` with `.<n>` inserted before its final extension (`main.log` → `main.2.log`). */
export function rotatedPath(basePath: string, n: number): string {
  const idx = basePath.lastIndexOf(".");
  if (idx === -1) return `${basePath}.${n}`;
  return `${basePath.slice(0, idx)}.${n}${basePath.slice(idx)}`;
}

/**
 * The rename plan for one rotation, highest-numbered backup first (so
 * applying them in order never clobbers a file it still needs to read):
 * `main.2.log` → `main.3.log` (dropping any old `main.3.log`), …,
 * `main.log` → `main.1.log`.
 */
export function rotationRenames(
  basePath: string,
  maxBackups: number = MAX_LOG_BACKUPS,
): Array<{ from: string; to: string }> {
  const renames: Array<{ from: string; to: string }> = [];
  for (let n = maxBackups; n >= 1; n--) {
    const from = n === 1 ? basePath : rotatedPath(basePath, n - 1);
    const to = rotatedPath(basePath, n);
    renames.push({ from, to });
  }
  return renames;
}

export interface AppLogFs {
  appendFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  rename(from: string, to: string): Promise<void>;
}

/** The real, Node-backed `AppLogFs`. */
export function nodeAppLogFs(): AppLogFs {
  return {
    appendFile: (path, data) => appendFile(path, data),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    stat: (path) => stat(path),
    rename: (from, to) => rename(from, to),
  };
}

export interface AppLog {
  /** Appends one formatted line; never throws, never blocks the caller. */
  write(level: LogLevel, args: readonly unknown[]): void;
  /** Resolves once every write queued so far has settled (tests only). */
  flush(): Promise<void>;
}

/**
 * A rotating append-only log at `logPath`. Writes are serialized on an
 * internal queue (one `fs` op in flight at a time) so concurrent
 * `console.error` calls never interleave or race the rotation check, and a
 * slow disk never backs up unboundedly — it just delays later lines.
 */
export function createAppLog(
  logPath: string,
  fs: AppLogFs = nodeAppLogFs(),
  options: {
    maxBytes?: number;
    maxBackups?: number;
    /** Repeat suppression for the file only (see log-dedupe.ts); the console tee is never filtered. */
    dedupe?: LogDedupe;
    now?: () => number;
  } = {},
): AppLog {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const maxBackups = options.maxBackups ?? MAX_LOG_BACKUPS;
  let queue: Promise<void> = Promise.resolve();
  let dirReady = false;

  async function rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await fs.stat(logPath)).size;
    } catch {
      return; // No file yet: nothing to rotate.
    }
    if (!shouldRotate(size, maxBytes)) return;
    for (const { from, to } of rotationRenames(logPath, maxBackups)) {
      try {
        await fs.rename(from, to);
      } catch {
        // Missing source (fewer backups exist yet than the plan expects) is
        // normal; any other failure still must not stop later renames.
      }
    }
  }

  function write(level: LogLevel, args: readonly unknown[]): void {
    // Secrets never reach the file (see log-redact.ts); dedupe sees the
    // redacted line so equal secrets collapse too.
    const line = redactLogLine(formatLogLine(level, args));
    const { dedupe } = options;
    if (!dedupe) {
      append(line);
      return;
    }
    for (const out of dedupe.filter(line, (options.now ?? Date.now)())) {
      append(out);
    }
  }

  if (options.dedupe) {
    const { dedupe } = options;
    // A window that ends with no later write still gets its summary.
    setInterval(() => {
      for (const out of dedupe.flushExpired((options.now ?? Date.now)())) {
        append(out);
      }
    }, 5_000).unref?.();
  }

  function append(line: string): void {
    queue = queue
      .then(async () => {
        if (!dirReady) {
          await fs.mkdir(dirname(logPath));
          dirReady = true;
        }
        await rotateIfNeeded();
        await fs.appendFile(logPath, `${line}\n`);
      })
      .catch(() => {
        // Logging must never break the app.
      });
  }

  return { write, flush: () => queue };
}

/**
 * Tees every `console.log/info/warn/error` call to `log` in addition to its
 * normal stdout/stderr destination (kept intact: e2e greps stdout for
 * `[main] uncaughtException`, and a packaged app's stdout is still useful
 * under a debugger/dev run). Returns a restore function (tests only; the
 * app itself installs this once for its whole lifetime).
 */
export function installConsoleTee(
  log: AppLog,
  target: Console = console,
): () => void {
  const originals = {
    log: target.log.bind(target),
    info: target.info.bind(target),
    warn: target.warn.bind(target),
    error: target.error.bind(target),
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    target[level] = (...args: unknown[]) => {
      originals[level](...args);
      log.write(level, args);
    };
  }
  return () => {
    target.log = originals.log;
    target.info = originals.info;
    target.warn = originals.warn;
    target.error = originals.error;
  };
}
