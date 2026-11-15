// Size and time limits for the "Export diagnostics" bundle (see
// diagnostics.ts). A bundle is something a user attaches to a bug report,
// so it must stay small and recent: each log kind is collected newest-first
// within a lookback window and a reserved byte budget, and the whole bundle
// has a hard cap. Everything here is pure except `readLogFile`/
// `rotatedLogFiles`, the (injectable) disk reads.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KiB = 1024;
const MiB = 1024 * KiB;

/** Default limits; `manifest.json` records the ones actually applied. */
export const DIAGNOSTICS_LIMITS = {
  /** Only log records newer than this are kept. */
  lookbackMs: 24 * 60 * 60 * 1000,
  /** Byte budget for `logs/main.log` (all rotations combined). */
  mainLogBytes: 3 * MiB,
  /** Byte budget reserved for `logs/wake.log` (all rotations combined). */
  wakeLogBytes: 256 * KiB,
  /** Byte budget for any other log kind found in the logs folder. */
  otherLogBytes: 256 * KiB,
  /** Hard cap on the whole bundle's uncompressed size. */
  bundleBytes: 8 * MiB,
  /** Room kept free for `manifest.json` and `logs/README.txt`. */
  metadataReserveBytes: 64 * KiB,
} as const;

export type DiagnosticsLimits = {
  -readonly [K in keyof typeof DIAGNOSTICS_LIMITS]: number;
};

/** A leading ISO-8601 timestamp (`2024-01-01T00:00:00.000Z ...`). */
const LEADING_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/;

/** The epoch-ms of a line's leading ISO timestamp, or `undefined` (a continuation line). */
export function leadingTimestamp(line: string): number | undefined {
  const match = LEADING_TIMESTAMP.exec(line);
  if (!match?.[1]) return undefined;
  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface LogTailOptions {
  maxBytes: number;
  lookbackMs: number;
  now: Date;
  /** Applied to each record's text before it is measured (redaction, home replacement). */
  transform?: (text: string) => string;
  /** File reader; a missing/unreadable file returns `undefined`. */
  read?: (path: string) => string | undefined;
}

export interface LogTailResult {
  /** Kept records, oldest first, newline-terminated. */
  text: string;
  /** Anything was left out (lookback, budget, or a cut record). */
  truncated: boolean;
  /** What stopped collection, when something did. */
  truncatedBy?: "lookback" | "budget";
  /** Lines read but not kept. */
  droppedLines: number;
  keptLines: number;
  /** ISO timestamps of the oldest / newest kept timestamped record. */
  oldestKept?: string;
  newestKept?: string;
  /** Files that existed and were read, newest first. */
  filesRead: string[];
}

export function readLogFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

interface LogRecord {
  /** Lines (timestamped head + continuation lines), in file order. */
  lines: string[];
  at?: number;
}

/** Splits a file into records: a timestamped line plus the untimestamped lines after it. Leading untimestamped lines form a head record without `at`. */
function splitRecords(text: string): LogRecord[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: LogRecord[] = [];
  for (const line of lines) {
    const at = leadingTimestamp(line);
    const last = records.at(-1);
    if (at === undefined && last) last.lines.push(line);
    else
      records.push(
        at === undefined ? { lines: [line] } : { lines: [line], at },
      );
  }
  return records;
}

/**
 * The newest log records across `files` (newest file first: `main.log`,
 * `main.1.log`, …) that fall within `lookbackMs` of `now` and fit in
 * `maxBytes`. Records are kept whole; lines without a leading timestamp
 * belong to the record before them, including across a rotation boundary
 * (the head of a newer file continues the last record of the older one).
 * A single newest record larger than the budget keeps its last bytes.
 */
export function collectLogTail(
  files: readonly string[],
  options: LogTailOptions,
): LogTailResult {
  const read = options.read ?? readLogFile;
  const transform = options.transform ?? ((text: string) => text);
  const cutoff = options.now.getTime() - options.lookbackMs;
  const kept: string[] = []; // newest first
  const filesRead: string[] = [];
  let bytes = 0;
  let droppedLines = 0;
  let keptLines = 0;
  let truncatedBy: LogTailResult["truncatedBy"];
  let partial = false;
  let oldest: number | undefined;
  let newest: number | undefined;
  // Untimestamped head of the newer file, continuing this file's last record.
  let carry: string[] = [];

  const consider = (record: LogRecord): void => {
    if (truncatedBy) {
      droppedLines += record.lines.length;
      return;
    }
    if (record.at !== undefined && record.at < cutoff) {
      truncatedBy = "lookback";
      droppedLines += record.lines.length;
      return;
    }
    let text = `${transform(record.lines.join("\n"))}\n`;
    let size = Buffer.byteLength(text);
    if (bytes + size > options.maxBytes) {
      if (kept.length > 0 || options.maxBytes <= 0) {
        truncatedBy = "budget";
        droppedLines += record.lines.length;
        return;
      }
      // The newest record alone exceeds the budget: keep its tail.
      text = Buffer.from(text)
        .subarray(-options.maxBytes)
        .toString("utf8")
        .replace(/^\uFFFD+/, "");
      size = Buffer.byteLength(text);
      partial = true;
      truncatedBy = "budget";
    }
    kept.push(text);
    bytes += size;
    keptLines += record.lines.length;
    if (record.at !== undefined) {
      newest ??= record.at;
      oldest = record.at;
    }
  };

  for (const file of files) {
    const content = read(file);
    if (content === undefined) continue;
    filesRead.push(file);
    const records = splitRecords(content);
    const last = records.at(-1);
    if (carry.length > 0) {
      if (last) last.lines.push(...carry);
      else records.push({ lines: carry });
      carry = [];
    }
    // A head record without a timestamp continues the next (older) file.
    const head = records[0];
    if (head && head.at === undefined) {
      records.shift();
      carry = head.lines;
    }
    for (let i = records.length - 1; i >= 0; i--) {
      consider(records[i] as LogRecord);
    }
  }
  // Untimestamped lines at the start of the oldest file: nothing to attach to.
  if (carry.length > 0) consider({ lines: carry });

  return {
    text: kept.reverse().join(""),
    truncated: truncatedBy !== undefined || partial || droppedLines > 0,
    ...(truncatedBy ? { truncatedBy } : {}),
    droppedLines,
    keptLines,
    ...(oldest !== undefined
      ? { oldestKept: new Date(oldest).toISOString() }
      : {}),
    ...(newest !== undefined
      ? { newestKept: new Date(newest).toISOString() }
      : {}),
    filesRead,
  };
}

/**
 * The log kind a file in the logs folder belongs to, and its rotation index
 * (0 = live file): `main.log` → (main.log, 0), `main.2.log` → (main.log, 2),
 * `wake.log.1` → (wake.log, 1). `undefined` for anything that isn't a `.log`.
 */
export function logKind(
  name: string,
): { base: string; index: number } | undefined {
  let match = /^(.+)\.(\d+)\.log$/.exec(name);
  if (match?.[1]) return { base: `${match[1]}.log`, index: Number(match[2]) };
  match = /^(.+\.log)\.(\d+)$/.exec(name);
  if (match?.[1]) return { base: match[1], index: Number(match[2]) };
  if (name.endsWith(".log")) return { base: name, index: 0 };
  return undefined;
}

/** Every log kind in `logsDir` (top level only) with its files newest first (live file, then `.1`, `.2`, …). */
export function rotatedLogFiles(logsDir: string): Map<string, string[]> {
  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return new Map();
  }
  const kinds = new Map<string, Array<{ path: string; index: number }>>();
  for (const name of names) {
    const kind = logKind(name);
    if (!kind) continue;
    const list = kinds.get(kind.base) ?? [];
    list.push({ path: join(logsDir, name), index: kind.index });
    kinds.set(kind.base, list);
  }
  const out = new Map<string, string[]>();
  for (const base of [...kinds.keys()].sort()) {
    const list = kinds.get(base) ?? [];
    out.set(
      base,
      list.sort((a, b) => a.index - b.index).map((file) => file.path),
    );
  }
  return out;
}

/** UTF-8 byte length of a string or buffer. */
export function byteSize(data: string | Buffer): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.length;
}

/**
 * `value` as pretty JSON within `maxBytes`. An oversized array keeps as
 * many leading items as fit (shape preserved); anything else oversized
 * becomes `{ truncated: true, originalBytes }`.
 */
export function capJson(
  value: unknown,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  if (Array.isArray(value)) {
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const size = Buffer.byteLength(
        `${JSON.stringify(value.slice(0, mid), null, 2)}\n`,
      );
      if (size <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    return {
      text: `${JSON.stringify(value.slice(0, lo), null, 2)}\n`,
      truncated: true,
      originalBytes,
    };
  }
  return {
    text: `${JSON.stringify({ truncated: true, originalBytes }, null, 2)}\n`,
    truncated: true,
    originalBytes,
  };
}

/** Plain text within `maxBytes`: keeps the head and appends a truncation marker. */
export function capText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  const marker = `\n[truncated: ${originalBytes} bytes, kept the first ${maxBytes}]\n`;
  const keep = Math.max(0, maxBytes - Buffer.byteLength(marker));
  return {
    text: `${Buffer.from(text)
      .subarray(0, keep)
      .toString("utf8")
      .replace(/\uFFFD+$/, "")}${marker}`,
    truncated: true,
    originalBytes,
  };
}
