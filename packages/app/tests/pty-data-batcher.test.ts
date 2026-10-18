// Main-process pty output batching + flow control (perf sweep): one IPC
// message per ~16ms flush instead of per OS read chunk, ordering preserved,
// pending output flushed ahead of an exit, a size guard, and pause/resume
// against renderer acknowledgements. The last block drives a real node-pty
// process through `createSession` to prove the wiring end to end.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPtyDataBatcher,
  createPtyFlowControl,
} from "../src/main/pty-data-batcher";
import { createSession, disposeSession } from "../src/main/ptySessions";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPtyDataBatcher", () => {
  it("coalesces chunks inside one interval into a single ordered send", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createPtyDataBatcher({
      send: (data) => sent.push(data),
      intervalMs: 16,
    });
    batcher.push("a");
    batcher.push("b");
    batcher.push("c");
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(15);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["abc"]);
    batcher.push("d");
    vi.advanceTimersByTime(16);
    expect(sent).toEqual(["abc", "d"]);
  });

  it("does not reset the timer on every push (a steady stream still flushes every interval)", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createPtyDataBatcher({
      send: (data) => sent.push(data),
      intervalMs: 16,
    });
    for (let i = 0; i < 10; i += 1) {
      batcher.push(String(i));
      vi.advanceTimersByTime(4);
    }
    // 40ms of pushes every 4ms: flushed at 16 and 32, remainder pending.
    expect(sent).toEqual(["0123", "4567"]);
    vi.advanceTimersByTime(16);
    expect(sent.join("")).toBe("0123456789");
  });

  it("flushes immediately past the size guard, preserving order", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createPtyDataBatcher({
      send: (data) => sent.push(data),
      intervalMs: 16,
      maxBufferedChars: 5,
    });
    batcher.push("ab");
    batcher.push("cde");
    expect(sent).toEqual(["abcde"]);
    batcher.push("f");
    vi.advanceTimersByTime(16);
    expect(sent).toEqual(["abcde", "f"]);
  });

  it("flush() sends pending output synchronously (the pre-exit flush) and cancels the timer", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const batcher = createPtyDataBatcher({
      send: (data) => events.push(`data:${data}`),
    });
    batcher.push("last words");
    batcher.flush();
    events.push("exit");
    vi.advanceTimersByTime(100);
    expect(events).toEqual(["data:last words", "exit"]);
    batcher.flush(); // empty: no extra send
    expect(events).toEqual(["data:last words", "exit"]);
  });

  it("dispose() drops pending output and ignores later pushes", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createPtyDataBatcher({ send: (data) => sent.push(data) });
    batcher.push("x");
    batcher.dispose();
    batcher.push("y");
    vi.advanceTimersByTime(100);
    batcher.flush();
    expect(sent).toEqual([]);
  });

  it("ignores empty chunks (no empty IPC message)", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createPtyDataBatcher({ send: (data) => sent.push(data) });
    batcher.push("");
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);
  });
});

describe("createPtyFlowControl", () => {
  it("pauses past the high watermark and resumes below the low watermark", () => {
    const calls: string[] = [];
    const flow = createPtyFlowControl({
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      highWatermark: 100,
      lowWatermark: 20,
    });
    flow.sent(60);
    flow.sent(40);
    expect(calls).toEqual([]); // exactly at high: not past it
    flow.sent(1);
    expect(calls).toEqual(["pause"]);
    expect(flow.paused).toBe(true);
    flow.sent(50); // already paused: no second pause
    flow.acknowledged(100);
    expect(calls).toEqual(["pause"]); // 51 outstanding, still >= low
    flow.acknowledged(40);
    expect(calls).toEqual(["pause", "resume"]);
    expect(flow.paused).toBe(false);
    expect(flow.outstanding).toBe(11);
  });

  it("never goes negative and ignores bogus acks", () => {
    const flow = createPtyFlowControl({
      pause: () => {},
      resume: () => {},
    });
    flow.sent(10);
    flow.acknowledged(Number.NaN);
    flow.acknowledged(-5);
    expect(flow.outstanding).toBe(10);
    flow.acknowledged(1_000);
    expect(flow.outstanding).toBe(0);
  });
});

describe("createSession output delivery (real pty)", () => {
  it("delivers every byte in order, all of it before the exit callback", async () => {
    const events: string[] = [];
    let output = "";
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const { id } = createSession(
      80,
      24,
      {
        onData: (data) => {
          events.push("data");
          output += data;
        },
        onExit: () => {
          events.push("exit");
          resolveExit();
        },
      },
      {
        spec: {
          command: "/bin/sh",
          args: [
            "-c",
            "i=0; while [ $i -lt 300 ]; do echo line-$i; i=$((i+1)); done",
          ],
          cwd: process.cwd(),
          env: {},
        },
      },
    );
    await exited;
    // Only after exit: disposing drops pending output by design.
    disposeSession(id);
    expect(events.at(-1)).toBe("exit");
    expect(events.filter((e) => e === "exit")).toHaveLength(1);
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("line-"));
    expect(lines).toEqual(
      Array.from({ length: 300 }, (_, index) => `line-${index}`),
    );
    // Coalesced: far fewer deliveries than lines.
    expect(events.filter((e) => e === "data").length).toBeLessThan(300);
  });
});
