import { describe, expect, it } from "vitest";
import { type AppLogFs, createAppLog } from "../src/main/app-log";
import {
  createLogDedupe,
  DEDUPE_WINDOW_MS,
  dedupeKey,
  isDedupeExempt,
} from "../src/main/log-dedupe";

const at = (ms: number) => new Date(ms).toISOString();
const line = (ms: number, body: string) => `${at(ms)} [ERROR] ${body}`;

describe("dedupeKey", () => {
  it("strips the leading ISO timestamp only", () => {
    expect(dedupeKey(line(0, "[presence] poll failed"))).toBe(
      "[ERROR] [presence] poll failed",
    );
    expect(dedupeKey("no timestamp here")).toBe("no timestamp here");
  });
});

describe("createLogDedupe", () => {
  it("writes the first copy, counts repeats, and summarizes at window end", () => {
    const dedupe = createLogDedupe();
    const msg = "[presence] poll failed: Error: listBoard exploded";
    expect(dedupe.filter(line(0, msg), 0)).toEqual([line(0, msg)]);
    for (let t = 5_000; t < DEDUPE_WINDOW_MS; t += 5_000) {
      expect(dedupe.filter(line(t, msg), t)).toEqual([]);
    }
    // Unrelated lines are untouched meanwhile.
    expect(dedupe.filter(line(30_000, "other"), 30_000)).toEqual([
      line(30_000, "other"),
    ]);
    expect(dedupe.flushExpired(DEDUPE_WINDOW_MS - 1)).toEqual([]);
    expect(dedupe.flushExpired(DEDUPE_WINDOW_MS)).toEqual([
      `${at(DEDUPE_WINDOW_MS)} [ERROR] … repeated 11 times in 60s: ${msg}`,
    ]);
    // A copy after the window opens a fresh one and is written again.
    expect(dedupe.filter(line(65_000, msg), 65_000)).toEqual([
      line(65_000, msg),
    ]);
  });

  it("emits pending summaries ahead of the line that triggered the flush", () => {
    const dedupe = createLogDedupe({ windowMs: 1_000 });
    dedupe.filter(line(0, "a"), 0);
    dedupe.filter(line(10, "a"), 10);
    expect(dedupe.filter(line(2_000, "b"), 2_000)).toEqual([
      `${at(2_000)} [ERROR] … repeated 1 times in 1s: a`,
      line(2_000, "b"),
    ]);
  });

  it("writes no summary for a line that was never repeated", () => {
    const dedupe = createLogDedupe({ windowMs: 1_000 });
    dedupe.filter(line(0, "once"), 0);
    expect(dedupe.flushExpired(5_000)).toEqual([]);
  });

  it("never suppresses uncaughtException lines", () => {
    const dedupe = createLogDedupe();
    const crash = "[main] uncaughtException: Error: boom";
    expect(isDedupeExempt(line(0, crash))).toBe(true);
    expect(dedupe.filter(line(0, crash), 0)).toEqual([line(0, crash)]);
    expect(dedupe.filter(line(1, crash), 1)).toEqual([line(1, crash)]);
    expect(dedupe.flushExpired(DEDUPE_WINDOW_MS * 2)).toEqual([]);
  });

  it("quotes only the first line of a multi-line message, capped", () => {
    const dedupe = createLogDedupe({ windowMs: 1_000 });
    const msg = `Error: ${"x".repeat(500)}\n    at stack (file.ts:1:1)`;
    dedupe.filter(line(0, msg), 0);
    dedupe.filter(line(1, msg), 1);
    const [summary] = dedupe.flushExpired(1_000);
    expect(summary).not.toContain("at stack");
    expect(summary?.endsWith("…")).toBe(true);
    expect(summary?.length).toBeLessThan(300);
  });

  it("bounds tracked keys by closing the oldest window early", () => {
    const dedupe = createLogDedupe({ maxKeys: 2 });
    dedupe.filter(line(0, "a"), 0);
    dedupe.filter(line(1, "a"), 1);
    dedupe.filter(line(2, "b"), 2);
    expect(dedupe.filter(line(3, "c"), 3)).toEqual([
      `${at(3)} [ERROR] … repeated 1 times in 60s: a`,
      line(3, "c"),
    ]);
  });
});

describe("createAppLog with dedupe", () => {
  it("drops repeated lines from the file", async () => {
    const appended: string[] = [];
    const fs: AppLogFs = {
      appendFile: async (_path, data) => {
        appended.push(data);
      },
      mkdir: async () => {},
      stat: async () => ({ size: 0 }),
      rename: async () => {},
    };
    let now = 0;
    const log = createAppLog("/tmp/x/main.log", fs, {
      dedupe: createLogDedupe(),
      now: () => now,
    });
    log.write("error", ["same"]);
    now = 5_000;
    log.write("error", ["same"]);
    log.write("error", ["[main] uncaughtException:", "boom"]);
    log.write("error", ["[main] uncaughtException:", "boom"]);
    now = 61_000;
    log.write("info", ["after"]);
    await log.flush();
    const bodies = appended.map((data) => dedupeKey(data.trimEnd()));
    expect(bodies).toEqual([
      "[ERROR] same",
      "[ERROR] [main] uncaughtException: boom",
      "[ERROR] [main] uncaughtException: boom",
      "[ERROR] … repeated 1 times in 60s: same",
      "[INFO] after",
    ]);
  });
});
