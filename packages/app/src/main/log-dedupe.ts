// Repeat suppression for main.log's *file* writes (see app-log.ts; the
// stdout tee is never filtered, e2e greps it). A bug that logs the same
// line every few seconds (a failing presence poll's `listBoard` error,
// every 5 s) used to bury everything else in the file and push useful
// history out through rotation. Now an identical line (compared with its
// leading timestamp stripped) is written once, further copies within the
// next 60 s are only counted, and when that window ends one
// `… repeated N times in 60s` line records how many were dropped. The next
// copy after the window opens a fresh one (written again), so a persistent
// error still shows up about once a minute.
//
// Pure: time is passed in, nothing touches disk or timers; app-log.ts
// feeds every formatted line through `filter` and periodically drains
// `flushExpired`.

export const DEDUPE_WINDOW_MS = 60_000;
/** Distinct lines tracked at once; the oldest window is closed early beyond this. */
export const DEDUPE_MAX_KEYS = 500;
/** The summary line quotes at most this much of the repeated line. */
export const DEDUPE_QUOTE_MAX = 200;

/** Lines never suppressed: a crash must always leave every occurrence behind. */
export function isDedupeExempt(line: string): boolean {
  return line.includes("[main] uncaughtException");
}

/**
 * The comparison key of one formatted log line: everything after its
 * leading ISO timestamp (`2026-01-01T00:00:00.000Z [ERROR] msg` →
 * `[ERROR] msg`). A line without one is its own key.
 */
export function dedupeKey(line: string): string {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /.exec(line);
  return match ? line.slice(match[0].length) : line;
}

/** `<iso> <level tag> … repeated N times in 60s: <quoted line, capped>`. */
export function formatRepeatLine(
  key: string,
  count: number,
  windowMs: number,
  nowMs: number,
): string {
  const levelMatch = /^(\[[A-Z]+\]) /.exec(key);
  const levelTag = levelMatch?.[1] ?? "[LOG]";
  const body = levelMatch ? key.slice(levelMatch[0].length) : key;
  const firstLine = body.split("\n", 1)[0] ?? "";
  const quoted =
    firstLine.length > DEDUPE_QUOTE_MAX
      ? `${firstLine.slice(0, DEDUPE_QUOTE_MAX)}…`
      : firstLine;
  const seconds = Math.round(windowMs / 1000);
  return `${new Date(nowMs).toISOString()} ${levelTag} … repeated ${count} times in ${seconds}s: ${quoted}`;
}

export interface LogDedupe {
  /**
   * The lines to actually write for `line` arriving at `nowMs`, in order:
   * summaries of any windows that have ended, then `line` itself unless it
   * repeats one still inside its window.
   */
  filter(line: string, nowMs: number): string[];
  /** Summaries of every window that has ended by `nowMs` (call periodically so a quiet log still gets them). */
  flushExpired(nowMs: number): string[];
}

interface Window {
  startedAt: number;
  suppressed: number;
}

export function createLogDedupe(
  options: { windowMs?: number; maxKeys?: number } = {},
): LogDedupe {
  const windowMs = options.windowMs ?? DEDUPE_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEDUPE_MAX_KEYS;
  // Insertion order == window start order, so expired ones sit at the front.
  const windows = new Map<string, Window>();

  function close(key: string, window: Window, nowMs: number, out: string[]) {
    windows.delete(key);
    if (window.suppressed > 0) {
      out.push(formatRepeatLine(key, window.suppressed, windowMs, nowMs));
    }
  }

  function flushExpired(nowMs: number): string[] {
    const out: string[] = [];
    for (const [key, window] of windows) {
      if (nowMs - window.startedAt < windowMs) break;
      close(key, window, nowMs, out);
    }
    return out;
  }

  function filter(line: string, nowMs: number): string[] {
    const out = flushExpired(nowMs);
    if (isDedupeExempt(line)) {
      out.push(line);
      return out;
    }
    const key = dedupeKey(line);
    const existing = windows.get(key);
    if (existing) {
      existing.suppressed += 1;
      return out;
    }
    if (windows.size >= maxKeys) {
      const oldest = windows.entries().next().value;
      if (oldest) close(oldest[0], oldest[1], nowMs, out);
    }
    windows.set(key, { startedAt: nowMs, suppressed: 0 });
    out.push(line);
    return out;
  }

  return { filter, flushExpired };
}
