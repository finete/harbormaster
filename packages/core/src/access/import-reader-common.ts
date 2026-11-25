// Shared plumbing of the import readers (docs/import.md "Performance"): the
// store roots, streaming a JSONL file line by line, the cheap "last
// timestamp in the file" read, and the per-(path, mtime, size) cache every
// reader keeps. Not exported from the package: only the readers use it.

import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/** Options every reader shares. */
export interface ImportReaderOptions {
  /**
   * The home folder every default root derives from (`~/.pi/agent`,
   * `~/.claude`, `~/.codex`, `~/.cursor`). With it set the environment is
   * NOT consulted (tests and e2e point all readers at a fake home with this
   * one option), unless `env` is given too.
   */
  home?: string;
  /** Environment for the root overrides (`PI_CODING_AGENT_DIR`, …); default `process.env`, or empty when `home` is set. */
  env?: Record<string, string | undefined>;
}

export function readerHome(options: ImportReaderOptions): string {
  return options.home ?? homedir();
}

export function readerEnv(
  options: ImportReaderOptions,
): Record<string, string | undefined> {
  return options.env ?? (options.home ? {} : process.env);
}

/** Lines of a file, streamed (a session file can be many MB); `onLine` returns `false` to stop early. */
export async function streamLines(
  path: string,
  onLine: (line: string) => boolean | undefined,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      if (line && onLine(line) === false) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The last `"timestamp":"<ISO>"` in the file's final 16 KB, if any (cheap: no full read). */
export async function lastTimestamp(
  path: string,
  size: number,
): Promise<string | undefined> {
  const length = Math.min(size, 16 * 1024);
  if (length === 0) return undefined;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const matches = [
      ...buffer
        .toString("utf8")
        .matchAll(/"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/g),
    ];
    return matches.at(-1)?.[1];
  } finally {
    await handle.close();
  }
}

export async function statOrUndefined(
  path: string,
): Promise<
  { mtimeMs: number; size: number; isDirectory: boolean } | undefined
> {
  try {
    const info = await stat(path);
    return {
      mtimeMs: info.mtimeMs,
      size: info.size,
      isDirectory: info.isDirectory(),
    };
  } catch {
    return undefined;
  }
}

/** Directory entries, `[]` for a missing or unreadable directory. */
export async function listDir(
  path: string,
): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch {
    return [];
  }
}

/** Per-file memo keyed by `(path, mtime, size)`: an unchanged file is never parsed twice. */
export class FileParseCache<T> {
  private readonly entries = new Map<
    string,
    { mtimeMs: number; size: number; value: T }
  >();

  async get(
    path: string,
    info: { mtimeMs: number; size: number },
    parse: () => Promise<T>,
  ): Promise<T> {
    const hit = this.entries.get(path);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      return hit.value;
    }
    const value = await parse();
    this.entries.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
    return value;
  }
}

export function isoOr(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return new Date(value).toISOString();
}
