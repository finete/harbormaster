// Export-time runtime evidence (main/diagnostics-runtime.ts): which agents
// and session files to look at, the one narrow `ps`, budgeted session file
// counts, the profiles' byte cap and the renderer hook's timeout.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiagnosticsState } from "../src/main/diagnostics";
import {
  agentProcessStats,
  parsePsOutput,
  profilesForBundle,
  rendererDiagnostics,
  runtimeTargets,
  sessionFileStats,
} from "../src/main/diagnostics-runtime";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-diag-runtime-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("runtimeTargets", () => {
  it("lists live agents and the session files of live or open tasks, once each", () => {
    const state: DiagnosticsState = {
      errors: {},
      tasks: [
        {
          task: { id: "live", state: "working", harness: "pi" },
          binding: { sessionPath: "/s/live.jsonl" },
          presence: {
            live: true,
            record: { pid: 111, sessionPath: "/s/live.jsonl" },
          },
        },
        {
          task: { id: "open-idle", state: "awaiting" },
          binding: { sessionPath: "/s/idle.jsonl" },
          presence: { live: false, record: { pid: 222 } },
        },
        {
          task: { id: "done", state: "done" },
          binding: { sessionPath: "/s/done.jsonl" },
        },
        { task: { id: "backlog", state: "backlog" } },
      ],
    };
    expect(runtimeTargets(state)).toEqual({
      agents: [
        {
          taskId: "live",
          harness: "pi",
          pid: 111,
          sessionPath: "/s/live.jsonl",
        },
      ],
      sessionFiles: [
        { taskId: "live", path: "/s/live.jsonl", live: true },
        { taskId: "open-idle", path: "/s/idle.jsonl", live: false },
      ],
    });
    expect(runtimeTargets(undefined)).toEqual({ agents: [], sessionFiles: [] });
  });
});

describe("agent process stats", () => {
  it("runs one ps for our pids only, numbers only, and marks a gone pid", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await agentProcessStats(
      [
        { taskId: "t1", harness: "pi", pid: 111 },
        { taskId: "t2", pid: 222 },
      ],
      async (file, args) => {
        calls.push({ file, args });
        return "  111     1  97.5 1953124 1-02:03:04    48:10.25\n";
      },
    );
    expect(calls).toEqual([
      {
        file: "/bin/ps",
        args: ["-o", "pid=,ppid=,pcpu=,rss=,etime=,time=", "-p", "111,222"],
      },
    ]);
    expect(result.agents).toEqual([
      {
        taskId: "t1",
        harness: "pi",
        pid: 111,
        ppid: 1,
        cpuPercent: 97.5,
        rssMb: 1907,
        elapsed: "1-02:03:04",
        cpuTime: "48:10.25",
      },
      { taskId: "t2", pid: 222, gone: true },
    ]);
  });

  it("runs nothing for no agents and reports a failed ps without failing", async () => {
    let ran = false;
    expect(
      await agentProcessStats([], async () => {
        ran = true;
        return "";
      }),
    ).toEqual({ agents: [] });
    expect(ran).toBe(false);
    const failed = await agentProcessStats(
      [{ taskId: "t", pid: 5 }],
      async () => {
        throw new Error("ps: blocked");
      },
    );
    expect(failed).toEqual({
      agents: [{ taskId: "t", pid: 5 }],
      error: "ps: blocked",
    });
  });

  it("parses ps output and skips junk lines", () => {
    expect(
      parsePsOutput("garbage\n 7 1 0.0 2048 00:05 0:00.01\n").get(7),
    ).toEqual({
      ppid: 1,
      cpuPercent: 0,
      rssMb: 2,
      elapsed: "00:05",
      cpuTime: "0:00.01",
    });
  });
});

describe("session file stats", () => {
  it("counts entries, and reports size caps, budgets and missing files", async () => {
    const dir = tempDir();
    const small = join(dir, "small.jsonl");
    writeFileSync(small, '{"a":1}\n{"b":2}\n{"c":3}\n');
    utimesSync(small, 1_700_000_000, 1_700_000_000);
    const big = join(dir, "big.jsonl");
    writeFileSync(big, "x\n".repeat(1_000));
    const stats = await sessionFileStats(
      [
        { taskId: "a", path: small, live: true },
        { taskId: "b", path: big, live: false },
        { taskId: "c", path: join(dir, "nope.jsonl"), live: false },
      ],
      { maxCountBytes: 1_000 },
    );
    expect(stats).toEqual([
      {
        taskId: "a",
        path: small,
        live: true,
        bytes: 24,
        modifiedAt: new Date(1_700_000_000_000).toISOString(),
        entries: 3,
      },
      expect.objectContaining({
        taskId: "b",
        bytes: 2_000,
        notCounted: "over 0 MB",
      }),
      {
        taskId: "c",
        path: join(dir, "nope.jsonl"),
        live: false,
        error: "missing",
      },
    ]);
  });

  it("gives up counting after the time budget", async () => {
    const dir = tempDir();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, "x\n".repeat(10));
    let clock = 0;
    const [stat] = await sessionFileStats([{ taskId: "a", path, live: true }], {
      budgetMs: 5,
      now: () => {
        clock += 10;
        return clock;
      },
    });
    expect(stat?.notCounted).toBe("over the 5 ms budget");
    expect(stat?.entries).toBeUndefined();
  });
});

describe("profiles for the bundle", () => {
  it("takes the newest first, within the byte cap", () => {
    const dir = tempDir();
    const write = (name: string, bytes: number, mtime: number) => {
      const path = join(dir, name);
      writeFileSync(path, "x".repeat(bytes));
      utimesSync(path, mtime, mtime);
    };
    write("old.cpuprofile", 300, 1_000);
    write("mid.cpuprofile", 900, 2_000);
    write("new.cpuprofile", 500, 3_000);
    expect(profilesForBundle(dir, 1_000).map((p) => p.name)).toEqual([
      "new.cpuprofile",
      "old.cpuprofile",
    ]);
    expect(profilesForBundle(join(dir, "missing"), 1_000)).toEqual([]);
  });
});

describe("renderer diagnostics hook", () => {
  it("returns the renderer's answer, or undefined on timeout or error", async () => {
    expect(
      await rendererDiagnostics(async () => ({ focus: { view: "workspace" } })),
    ).toEqual({
      focus: { view: "workspace" },
    });
    expect(
      await rendererDiagnostics(() => new Promise(() => {}), 20),
    ).toBeUndefined();
    expect(
      await rendererDiagnostics(async () => {
        throw new Error("destroyed");
      }),
    ).toBeUndefined();
  });
});
