import { describe, expect, it } from "vitest";
import {
  CRASH_REPORT_MAX_AGE_MS,
  filterCrashReports,
  getLastUncleanExit,
  listRecentCrashReports,
  parseSentinel,
  type SentinelFs,
  startRunSentinel,
} from "../src/main/run-sentinel";

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: SentinelFs = {
    readFile: (path) => files.get(path),
    writeFile: (path, data) => {
      files.set(path, data);
    },
    remove: (path) => {
      files.delete(path);
    },
    mkdir: () => {},
  };
  return { fs, files };
}

const PATH = "/u/logs/running.sentinel";

describe("startRunSentinel", () => {
  it("writes this run's sentinel and removes it on a clean exit", () => {
    const { fs, files } = memoryFs();
    const lines: string[] = [];
    const sentinel = startRunSentinel({
      path: PATH,
      pid: 42,
      version: "1.2.3",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      fs,
      log: (l) => lines.push(l),
    });
    expect(sentinel.previous).toBeUndefined();
    expect(JSON.parse(files.get(PATH) ?? "")).toEqual({
      pid: 42,
      version: "1.2.3",
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(lines).toEqual([]);
    sentinel.markCleanExit();
    sentinel.markCleanExit();
    expect(files.has(PATH)).toBe(false);
    expect(lines).toEqual(["[main] clean exit"]);
  });

  it("reports and remembers a previous run's leftover sentinel", () => {
    const previous = {
      pid: 7,
      version: "0.2.2",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const { fs, files } = memoryFs({ [PATH]: JSON.stringify(previous) });
    const lines: string[] = [];
    const sentinel = startRunSentinel({
      path: PATH,
      pid: 8,
      version: "0.2.3",
      fs,
      log: (l) => lines.push(l),
    });
    expect(sentinel.previous).toEqual(previous);
    expect(getLastUncleanExit()).toEqual(previous);
    expect(lines).toEqual([
      "[main] previous run did not exit cleanly (pid 7, version 0.2.2, started 2026-01-01T00:00:00.000Z)",
    ]);
    // Replaced by this run's own.
    expect(JSON.parse(files.get(PATH) ?? "").pid).toBe(8);
  });

  it("never throws when the fs fails", () => {
    const fs: SentinelFs = {
      readFile: () => {
        throw new Error("EACCES");
      },
      writeFile: () => {
        throw new Error("EROFS");
      },
      remove: () => {
        throw new Error("EROFS");
      },
      mkdir: () => {},
    };
    const lines: string[] = [];
    const sentinel = startRunSentinel({
      path: PATH,
      pid: 1,
      version: "x",
      fs,
      log: (l) => lines.push(l),
    });
    expect(() => sentinel.markCleanExit()).not.toThrow();
    expect(lines.at(-1)).toBe("[main] clean exit");
  });

  it("parses a garbled sentinel as unknown fields", () => {
    expect(parseSentinel("{not json")).toEqual({
      pid: null,
      version: "unknown",
      startedAt: "unknown",
    });
  });
});

describe("crash reports", () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");

  it("keeps Harbormaster reports from the last 3 days, newest first", () => {
    const result = filterCrashReports(
      [
        { name: "Harbormaster-2026-03-09.ips", mtimeMs: now - 86_400_000 },
        { name: "Harbormaster Helper-2026-03-10.ips", mtimeMs: now - 1_000 },
        {
          name: "Harbormaster-old.ips",
          mtimeMs: now - CRASH_REPORT_MAX_AGE_MS - 1,
        },
        { name: "Safari-2026-03-10.ips", mtimeMs: now - 1_000 },
      ],
      now,
    );
    expect(result).toEqual([
      {
        name: "Harbormaster Helper-2026-03-10.ips",
        mtime: new Date(now - 1_000).toISOString(),
      },
      {
        name: "Harbormaster-2026-03-09.ips",
        mtime: new Date(now - 86_400_000).toISOString(),
      },
    ]);
  });

  it("lists names via an injectable fs and is empty off macOS or on error", () => {
    const fs = {
      readdir: () => ["Harbormaster-a.ips", "Other.ips"],
      mtimeMs: () => now - 10,
    };
    expect(
      listRecentCrashReports({ dir: "/r", nowMs: now, platform: "darwin", fs }),
    ).toEqual([
      { name: "Harbormaster-a.ips", mtime: new Date(now - 10).toISOString() },
    ]);
    expect(
      listRecentCrashReports({ dir: "/r", nowMs: now, platform: "linux", fs }),
    ).toEqual([]);
    expect(
      listRecentCrashReports({
        dir: "/r",
        nowMs: now,
        platform: "darwin",
        fs: {
          readdir: () => {
            throw new Error("ENOENT");
          },
          mtimeMs: () => 0,
        },
      }),
    ).toEqual([]);
  });
});
