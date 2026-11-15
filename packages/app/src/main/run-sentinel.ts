// Crash sentinel: `<userData>/logs/running.sentinel` (pid, version,
// startedAt) is written at startup and removed on a clean `will-quit`
// (`[main] clean exit`). Finding one at the next startup means the previous
// run never got there — crashed, was force-quit, or the machine went down —
// which is logged once (`[main] previous run did not exit cleanly …`) and
// kept for diagnostics behind `getLastUncleanExit()`.
//
// Also lists the newest macOS crash reports for the app
// (`~/Library/Logs/DiagnosticReports/Harbormaster*`) — names and mtimes
// only, never contents — for the diagnostics bundle to mention.
//
// All file access goes through an injectable, synchronous `SentinelFs`:
// the file is tiny and the removal has to land before the process exits.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SENTINEL_FILE_NAME = "running.sentinel";
export const CRASH_REPORT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const CRASH_REPORT_PREFIX = "Harbormaster";
const CRASH_REPORT_MAX_ENTRIES = 20;

export interface SentinelInfo {
  pid: number | null;
  version: string;
  startedAt: string;
}

export interface SentinelFs {
  /** `undefined` when the file doesn't exist or can't be read. */
  readFile(path: string): string | undefined;
  writeFile(path: string, data: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
}

export function nodeSentinelFs(): SentinelFs {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile: (path, data) => writeFileSync(path, data),
    remove: (path) => rmSync(path, { force: true }),
    mkdir: (path) => {
      mkdirSync(path, { recursive: true });
    },
  };
}

/** A sentinel file's content; an unreadable/garbled file still counts as an unclean exit, with unknown fields. */
export function parseSentinel(text: string): SentinelInfo {
  try {
    const parsed = JSON.parse(text) as Partial<Record<string, unknown>>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
    };
  } catch {
    return { pid: null, version: "unknown", startedAt: "unknown" };
  }
}

export function formatUncleanExitLine(info: SentinelInfo): string {
  return `[main] previous run did not exit cleanly (pid ${info.pid ?? "unknown"}, version ${info.version}, started ${info.startedAt})`;
}

let lastUncleanExit: SentinelInfo | undefined;

/** The previous run's sentinel when it did not exit cleanly, as found at this startup; `undefined` otherwise. */
export function getLastUncleanExit(): SentinelInfo | undefined {
  return lastUncleanExit;
}

export interface RunSentinel {
  /** The previous run's leftover sentinel, if any. */
  previous: SentinelInfo | undefined;
  /** Removes this run's sentinel and logs `[main] clean exit`. Idempotent. */
  markCleanExit(): void;
}

/**
 * Checks for a previous run's sentinel (logging and remembering it), then
 * writes this run's. Never throws: a sentinel failure must not stop the app.
 */
export function startRunSentinel(input: {
  path: string;
  pid: number;
  version: string;
  now?: () => Date;
  fs?: SentinelFs;
  log?: (line: string) => void;
}): RunSentinel {
  const fs = input.fs ?? nodeSentinelFs();
  const log = input.log ?? ((line: string) => console.log(line));
  let previous: SentinelInfo | undefined;
  try {
    const text = fs.readFile(input.path);
    if (text !== undefined) {
      previous = parseSentinel(text);
      lastUncleanExit = previous;
      log(formatUncleanExitLine(previous));
    }
  } catch {
    // Unreadable: treat as no previous sentinel.
  }
  try {
    fs.mkdir(dirname(input.path));
    const info: SentinelInfo = {
      pid: input.pid,
      version: input.version,
      startedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    fs.writeFile(input.path, JSON.stringify(info));
  } catch (error) {
    log(`[main] writing the run sentinel failed: ${String(error)}`);
  }
  let done = false;
  return {
    previous,
    markCleanExit: () => {
      if (done) return;
      done = true;
      try {
        fs.remove(input.path);
      } catch {
        // Next startup will just report this run as unclean.
      }
      log("[main] clean exit");
    },
  };
}

export interface CrashReportEntry {
  name: string;
  mtime: string;
}

export interface CrashReportFs {
  readdir(dir: string): string[];
  mtimeMs(path: string): number;
}

/**
 * Pure filter: entries whose name starts with `prefix` and whose mtime is
 * within `maxAgeMs` of `nowMs`, newest first, at most 20.
 */
export function filterCrashReports(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
  nowMs: number,
  maxAgeMs: number = CRASH_REPORT_MAX_AGE_MS,
  prefix: string = CRASH_REPORT_PREFIX,
): CrashReportEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.name.startsWith(prefix) &&
        nowMs - entry.mtimeMs <= maxAgeMs &&
        entry.mtimeMs <= nowMs + 60_000,
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CRASH_REPORT_MAX_ENTRIES)
    .map((entry) => ({
      name: entry.name,
      mtime: new Date(entry.mtimeMs).toISOString(),
    }));
}

/**
 * The app's macOS crash reports from the last 3 days (names + mtimes only,
 * never contents); `[]` off macOS or when the folder can't be read.
 */
export function listRecentCrashReports(
  input: {
    dir?: string;
    nowMs?: number;
    platform?: NodeJS.Platform;
    fs?: CrashReportFs;
  } = {},
): CrashReportEntry[] {
  if ((input.platform ?? process.platform) !== "darwin") return [];
  const dir =
    input.dir ?? join(homedir(), "Library", "Logs", "DiagnosticReports");
  const fs: CrashReportFs = input.fs ?? {
    readdir: (d) => readdirSync(d),
    mtimeMs: (p) => statSync(p).mtimeMs,
  };
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.startsWith(CRASH_REPORT_PREFIX)) continue;
    try {
      entries.push({ name, mtimeMs: fs.mtimeMs(join(dir, name)) });
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return filterCrashReports(entries, input.nowMs ?? Date.now());
}
