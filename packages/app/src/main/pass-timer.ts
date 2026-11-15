// Timing for the main process's heavy periodic passes (refresh tick,
// presence poll, renderer `listBoard`, orphan-worktree scan, background-
// launcher pass): `[pass] <name> ms=… items=…` lines (names, durations and
// counts only, never task content), the set of passes running right now
// (for `[health] spike` lines) and per-window stats (count / max ms, for
// the minutely `[health]` line).
//
// Not every run is worth a line: presence and the launcher tick every 5 s
// and would flood main.log. A run is logged when it is the first of its
// name this process, slower than `slowMs`, or its name is in `alwaysLog`
// (the rare, expensive ones); every other run goes to `debugLog` and still
// counts toward the `[health]` line's pass stats.
import { debugLog } from "./debug-log";

/** A pass at least this slow is always logged. */
export const PASS_SLOW_MS = 100;

/** Passes rare and expensive enough to log on every run. */
export const ALWAYS_LOGGED_PASSES: ReadonlySet<string> = new Set([
  "refresh",
  "scanOrphanWorktrees",
]);

export interface PassStats {
  n: number;
  maxMs: number;
  totalMs: number;
  failed: number;
}

/** `[pass] <name> ms=<ms> [items=<n>] [failed=true]` */
export function formatPassLine(
  name: string,
  ms: number,
  items: number | undefined,
  failed = false,
): string {
  let line = `[pass] ${name} ms=${Math.round(ms)}`;
  if (items !== undefined) line += ` items=${items}`;
  if (failed) line += " failed=true";
  return line;
}

export function shouldLogPass(input: {
  name: string;
  ms: number;
  firstRun: boolean;
  slowMs?: number;
  alwaysLog?: ReadonlySet<string>;
}): boolean {
  return (
    input.firstRun ||
    input.ms >= (input.slowMs ?? PASS_SLOW_MS) ||
    (input.alwaysLog ?? ALWAYS_LOGGED_PASSES).has(input.name)
  );
}

export interface PassTimer {
  /** Runs `fn` as pass `name`; `items` derives the item count from its result. Rejections pass through unchanged. */
  run<T>(
    name: string,
    fn: () => Promise<T>,
    items?: (result: T) => number | undefined,
  ): Promise<T>;
  /** Names of passes in flight right now (sorted, deduplicated). */
  running(): string[];
  /** Per-name stats since the last call, then resets them. */
  drainStats(): Record<string, PassStats>;
}

export function createPassTimer(
  options: {
    now?: () => number;
    log?: (line: string) => void;
    debug?: (line: string) => void;
    slowMs?: number;
    alwaysLog?: ReadonlySet<string>;
  } = {},
): PassTimer {
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const debug = options.debug ?? ((line: string) => debugLog("pass", line));
  const inFlight = new Map<string, number>();
  const seen = new Set<string>();
  let stats: Record<string, PassStats> = {};

  function finish(
    name: string,
    ms: number,
    items: number | undefined,
    failed: boolean,
  ) {
    const count = (inFlight.get(name) ?? 1) - 1;
    if (count <= 0) inFlight.delete(name);
    else inFlight.set(name, count);
    const entry = stats[name] ?? { n: 0, maxMs: 0, totalMs: 0, failed: 0 };
    stats[name] = entry;
    entry.n += 1;
    entry.maxMs = Math.max(entry.maxMs, Math.round(ms));
    entry.totalMs += Math.round(ms);
    if (failed) entry.failed += 1;
    const firstRun = !seen.has(name);
    seen.add(name);
    const line = formatPassLine(name, ms, items, failed);
    const loud = shouldLogPass({
      name,
      ms,
      firstRun,
      ...(options.slowMs !== undefined ? { slowMs: options.slowMs } : {}),
      ...(options.alwaysLog ? { alwaysLog: options.alwaysLog } : {}),
    });
    (loud ? log : debug)(line);
  }

  async function run<T>(
    name: string,
    fn: () => Promise<T>,
    items?: (result: T) => number | undefined,
  ): Promise<T> {
    inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
    const start = now();
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      finish(name, now() - start, undefined, true);
      throw error;
    }
    let count: number | undefined;
    try {
      count = items?.(result);
    } catch {
      count = undefined;
    }
    finish(name, now() - start, count, false);
    return result;
  }

  return {
    run,
    running: () => [...inFlight.keys()].sort(),
    drainStats: () => {
      const out = stats;
      stats = {};
      return out;
    },
  };
}

/** The app-wide instance main/index.ts times its passes with. */
export const passTimer = createPassTimer();
