import { describe, expect, it, vi } from "vitest";
import {
  type AppLogFs,
  createAppLog,
  formatLogLine,
  installQuitLogFlush,
  MAX_LOG_BACKUPS,
  rotatedPath,
  rotationRenames,
  shouldRotate,
  stringifyLogArg,
} from "../src/main/app-log";

describe("stringifyLogArg", () => {
  it("keeps strings as-is", () => {
    expect(stringifyLogArg("hello")).toBe("hello");
  });
  it("prints an Error's stack", () => {
    const error = new Error("boom");
    expect(stringifyLogArg(error)).toBe(error.stack);
  });
  it("JSON-stringifies plain objects", () => {
    expect(stringifyLogArg({ a: 1 })).toBe('{"a":1}');
  });
  it("falls back to String() for values JSON can't handle", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyLogArg(circular)).toBe(String(circular));
  });
});

describe("formatLogLine", () => {
  it("joins args with a space behind an ISO timestamp and level", () => {
    const now = new Date("2024-01-02T03:04:05.000Z");
    expect(formatLogLine("error", ["[main]", "boom"], now)).toBe(
      "2024-01-02T03:04:05.000Z [ERROR] [main] boom",
    );
  });
});

describe("shouldRotate", () => {
  it("is false at and under the limit, true over it", () => {
    expect(shouldRotate(100, 100)).toBe(false);
    expect(shouldRotate(101, 100)).toBe(true);
  });
});

describe("rotatedPath", () => {
  it("inserts .<n> before the final extension", () => {
    expect(rotatedPath("/x/main.log", 1)).toBe("/x/main.1.log");
    expect(rotatedPath("/x/main.log", 3)).toBe("/x/main.3.log");
  });
  it("appends .<n> when there is no extension", () => {
    expect(rotatedPath("/x/main", 2)).toBe("/x/main.2");
  });
});

describe("rotationRenames", () => {
  it("plans highest-backup-first renames, ending with the live file", () => {
    expect(rotationRenames("/x/main.log", 3)).toEqual([
      { from: "/x/main.2.log", to: "/x/main.3.log" },
      { from: "/x/main.1.log", to: "/x/main.2.log" },
      { from: "/x/main.log", to: "/x/main.1.log" },
    ]);
  });
  it("defaults to MAX_LOG_BACKUPS", () => {
    expect(rotationRenames("/x/main.log")).toHaveLength(MAX_LOG_BACKUPS);
  });
});

function fakeFs(initialSizes: Record<string, number> = {}): AppLogFs & {
  appended: Array<{ path: string; data: string }>;
  renamed: Array<{ from: string; to: string }>;
  sizes: Record<string, number>;
} {
  const sizes = { ...initialSizes };
  const appended: Array<{ path: string; data: string }> = [];
  const renamed: Array<{ from: string; to: string }> = [];
  return {
    sizes,
    appended,
    renamed,
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(async (path: string) => {
      if (!(path in sizes)) throw new Error("ENOENT");
      return { size: sizes[path] };
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (!(from in sizes)) throw new Error("ENOENT");
      sizes[to] = sizes[from];
      delete sizes[from];
      renamed.push({ from, to });
    }),
    appendFile: vi.fn(async (path: string, data: string) => {
      appended.push({ path, data });
      sizes[path] = (sizes[path] ?? 0) + data.length;
    }),
  };
}

describe("createAppLog", () => {
  it("appends a formatted line per write, serialized", async () => {
    const fs = fakeFs();
    const log = createAppLog("/logs/main.log", fs);
    log.write("error", ["[main]", "boom"]);
    log.write("log", ["hello"]);
    await log.flush();
    expect(fs.appended).toHaveLength(2);
    expect(fs.appended[0]?.data).toMatch(/\[ERROR] \[main] boom\n$/);
    expect(fs.appended[1]?.data).toMatch(/\[LOG] hello\n$/);
  });

  it("rotates once the file exceeds maxBytes before the next append", async () => {
    const fs = fakeFs({ "/logs/main.log": 1000 });
    const log = createAppLog("/logs/main.log", fs, { maxBytes: 500 });
    log.write("error", ["big"]);
    await log.flush();
    expect(fs.renamed).toEqual([
      { from: "/logs/main.log", to: "/logs/main.1.log" },
    ]);
    expect(fs.appended[0]?.path).toBe("/logs/main.log");
  });

  it("never throws past the caller when the fs backend fails", async () => {
    const fs = fakeFs();
    fs.appendFile = vi.fn(async () => {
      throw new Error("disk full");
    });
    const log = createAppLog("/logs/main.log", fs);
    expect(() => log.write("error", ["x"])).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe("installQuitLogFlush", () => {
  /** Wires the flush to a fake `will-quit`; returns a trigger and the exit spy. */
  function wire(log: { flush(): Promise<void> }, timeoutMs?: number) {
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    const exit = vi.fn();
    installQuitLogFlush(log, (l) => (listener = l), exit, timeoutMs);
    const willQuit = () => {
      const event = { preventDefault: vi.fn() };
      listener?.(event);
      return event;
    };
    return { willQuit, exit };
  }

  it("holds the quit until lines logged by every will-quit listener are written", async () => {
    // A disk slow enough that a line is still queued when the quit lands.
    let release: () => void = () => {};
    const fs = fakeFs();
    fs.appendFile = vi.fn(
      (path: string, data: string) =>
        new Promise<void>((resolve) => {
          release = () => {
            fs.appended.push({ path, data });
            resolve();
          };
        }),
    );
    const log = createAppLog("/logs/main.log", fs);
    const { willQuit, exit } = wire(log);

    const event = willQuit();
    // A later will-quit listener in the same emit (the run sentinel).
    log.write("log", ["[main] clean exit"]);
    expect(event.preventDefault).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(fs.appendFile).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(fs.appended[0]?.data).toMatch(/\[main] clean exit\n$/);
  });

  it("exits anyway once the timeout passes on a stuck disk", async () => {
    const { willQuit, exit } = wire({ flush: () => new Promise(() => {}) }, 30);
    willQuit();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });

  it("holds only the first will-quit", async () => {
    const { willQuit, exit } = wire({ flush: async () => undefined });
    expect(willQuit().preventDefault).toHaveBeenCalledOnce();
    expect(willQuit().preventDefault).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });
});
