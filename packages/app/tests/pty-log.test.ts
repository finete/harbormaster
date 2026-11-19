import { describe, expect, it } from "vitest";
import {
  formatPtyExitLine,
  formatPtyLifecycleLine,
  formatPtySpawnFailureLine,
  formatPtySpawnLine,
  OutputRingBuffer,
  ptyEnvFlags,
  redactPromptArgs,
  stripAnsi,
} from "../src/main/pty-log";

describe("stripAnsi", () => {
  it("removes CSI color/cursor sequences", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });
  it("removes OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsi("\x1b]0;title\x07rest")).toBe("rest");
    expect(stripAnsi("\x1b]0;title\x1b\\rest")).toBe("rest");
  });
  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain text, no escapes")).toBe("plain text, no escapes");
  });
});

describe("OutputRingBuffer", () => {
  it("keeps only the newest N non-empty, ANSI-stripped lines", () => {
    const buf = new OutputRingBuffer(2, 100);
    buf.push("\x1b[31mone\x1b[0m\ntwo\nthree\n");
    expect(buf.tail()).toEqual(["two", "three"]);
  });
  it("drops blank lines", () => {
    const buf = new OutputRingBuffer(10, 100);
    buf.push("a\n\n   \nb\n");
    expect(buf.tail()).toEqual(["a", "b"]);
  });
  it("caps an individual line's length", () => {
    const buf = new OutputRingBuffer(10, 5);
    buf.push("abcdefgh\n");
    expect(buf.tail()).toEqual(["abcde…"]);
  });
  it("strips an escape sequence split across chunks", () => {
    const buf = new OutputRingBuffer(10, 100);
    buf.push("hello \x1b[3");
    buf.push("1mred\x1b[0m\na\x1b]0;ti");
    buf.push("tle\x07b\x1b");
    buf.push("[0m\n");
    expect(buf.tail()).toEqual(["hello red", "ab"]);
  });
  it("caps a long line built up over many chunks, and \\r\\n split across them", () => {
    const buf = new OutputRingBuffer(10, 5);
    buf.push("   ab");
    buf.push("cdefgh\r");
    buf.push("\nnext   ");
    buf.push("      \n");
    expect(buf.tail()).toEqual(["abcde…", "next"]);
  });
  it("costs O(chunk) on endless newline-free output (Pi's fullscreen UI)", () => {
    // Before: the partial line grew without bound and every chunk
    // re-stripped all of it, so this took minutes. Now it is linear.
    const buf = new OutputRingBuffer();
    const frame =
      `\x1b[12;1H${"x".repeat(80)}\x1b[13;1H${"y".repeat(80)}`.repeat(60);
    const started = performance.now();
    for (let drawn = 0; drawn < 30_000_000; drawn += frame.length) {
      buf.push(frame);
    }
    expect(performance.now() - started).toBeLessThan(5000);
    buf.push("\ndone\n");
    expect(buf.tail()).toEqual([
      `${"x".repeat(80)}${"y".repeat(80)}${"x".repeat(40)}…`,
      "done",
    ]);
  });
  it("holds a trailing partial line until it is terminated", () => {
    const buf = new OutputRingBuffer(10, 100);
    buf.push("partial-no-newline");
    expect(buf.tail()).toEqual([]);
    buf.push(" more\n");
    expect(buf.tail()).toEqual(["partial-no-newline more"]);
  });
});

describe("redactPromptArgs", () => {
  it("replaces the element right after a literal -- with its length", () => {
    expect(
      redactPromptArgs(["--session-id", "abc", "--", "do the thing"]),
    ).toEqual(["--session-id", "abc", "--", "<prompt 12 chars>"]);
  });
  it("leaves argv alone when there is no -- (no prompt this launch)", () => {
    expect(redactPromptArgs(["--continue"])).toEqual(["--continue"]);
  });
  it("leaves argv alone when -- is the last element", () => {
    expect(redactPromptArgs(["--continue", "--"])).toEqual([
      "--continue",
      "--",
    ]);
  });
});

describe("ptyEnvFlags", () => {
  it("surfaces the task id value and presence-only flags, never secret values", () => {
    expect(
      ptyEnvFlags({
        HARBORMASTER_TASK_ID: "t1",
        HARBORMASTER_SESSION_ID: "s1",
        HARBORMASTER_MCP_SERVER: '{"command":"x"}',
      }),
    ).toEqual({ taskId: "t1", hasSessionId: true, hasMcpServer: true });
  });
  it("is false/undefined when absent", () => {
    expect(ptyEnvFlags({})).toEqual({
      taskId: undefined,
      hasSessionId: false,
      hasMcpServer: false,
    });
  });
});

describe("formatPtySpawnLine", () => {
  it("includes identifying fields, a redacted argv, and env flags — never raw env", () => {
    const line = formatPtySpawnLine({
      sessionId: "sess-1",
      taskId: "task-1",
      kind: "primary",
      harness: "pi",
      cwd: "/work/task-1",
      command: "pi",
      resolvedCommand: "/Users/me/.local/bin/pi",
      argv: ["--", "fix the thing"],
      env: { HARBORMASTER_TASK_ID: "task-1", SOME_SECRET: "sh-hh" },
    });
    expect(line).toContain('"id":"sess-1"');
    expect(line).toContain('"task":"task-1"');
    expect(line).toContain('"kind":"primary"');
    expect(line).toContain('"resolved":"/Users/me/.local/bin/pi"');
    expect(line).toContain('"<prompt 13 chars>"');
    expect(line).not.toContain("fix the thing");
    expect(line).not.toContain("sh-hh");
  });
  it("uses - placeholders for an absent task/harness", () => {
    const line = formatPtySpawnLine({
      sessionId: "sess-2",
      kind: "shell",
      cwd: "/work",
      command: "/bin/bash",
      resolvedCommand: null,
      argv: [],
      env: {},
    });
    expect(line).toContain('"task":"-"');
    expect(line).toContain('"harness":"-"');
    expect(line).toContain('"resolved":null');
  });
});

describe("formatPtySpawnFailureLine", () => {
  it("reports the error message, never arguments", () => {
    const line = formatPtySpawnFailureLine({
      sessionId: "sess-1",
      taskId: "task-1",
      kind: "primary",
      command: "/usr/local/bin/pi",
      error: new Error("ENOENT"),
    });
    expect(line).toContain('"error":"ENOENT"');
  });
});

describe("formatPtyExitLine", () => {
  it("includes exit code, signal and duration", () => {
    const line = formatPtyExitLine({
      sessionId: "sess-1",
      taskId: "task-1",
      kind: "primary",
      exitCode: 0,
      spawnedAtMs: 1_000,
      exitedAtMs: 50_000,
    });
    expect(line).toContain('"exitCode":0');
    expect(line).toContain('"durationMs":49000');
    expect(line).not.toContain("tail");
  });
  it("includes the output tail only for an early exit", () => {
    const early = formatPtyExitLine({
      sessionId: "sess-1",
      kind: "primary",
      exitCode: 1,
      spawnedAtMs: 1_000,
      exitedAtMs: 2_000,
      recentOutput: ["line one", "line two"],
    });
    expect(early).toContain('"tail":["line one","line two"]');

    const late = formatPtyExitLine({
      sessionId: "sess-1",
      kind: "primary",
      exitCode: 1,
      spawnedAtMs: 1_000,
      exitedAtMs: 1_000 + 40_000,
      recentOutput: ["line one"],
    });
    expect(late).not.toContain("tail");
  });
});

describe("formatPtyLifecycleLine", () => {
  it("names the event and the session/task ids", () => {
    expect(formatPtyLifecycleLine("attach", "sess-1", "task-1")).toBe(
      '[pty] attach {"id":"sess-1","task":"task-1"}',
    );
    expect(formatPtyLifecycleLine("dispose", "sess-2")).toBe(
      '[pty] dispose {"id":"sess-2","task":"-"}',
    );
  });
});
