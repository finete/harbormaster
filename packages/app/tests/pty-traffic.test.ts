// Pty output accounting (main/pty-traffic.ts): per-minute windows for the
// health line, and lifetime totals per live session that survive window
// drains until the session is retired.
import { describe, expect, it } from "vitest";
import { createPtyTraffic } from "../src/main/pty-traffic";

describe("pty traffic lifetime totals", () => {
  it("accumulate across window drains, most bytes first, until the session ends", () => {
    const traffic = createPtyTraffic(() => 0);
    traffic.record("a", "t1", 100, 1_000);
    traffic.record("b", "t2", 50, 2_000);
    expect(traffic.drainWindow(3).totalBytes).toBe(150);
    traffic.record("a", "t1", 400, 70_000);
    expect(traffic.drainWindow(3).top).toEqual([
      { sessionId: "a", taskId: "t1", bytes: 400 },
    ]);
    expect(traffic.lifetime()).toEqual([
      { sessionId: "a", taskId: "t1", bytes: 500, chunks: 2, startedAt: 1_000 },
      { sessionId: "b", taskId: "t2", bytes: 50, chunks: 1, startedAt: 2_000 },
    ]);
    traffic.end("a");
    expect(traffic.lifetime().map((entry) => entry.sessionId)).toEqual(["b"]);
    // A returned entry is a copy: callers can't change the totals.
    const [entry] = traffic.lifetime();
    if (entry) entry.bytes = 0;
    expect(traffic.lifetime()[0]?.bytes).toBe(50);
  });
});
