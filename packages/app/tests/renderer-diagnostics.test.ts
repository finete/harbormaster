// The renderer's long-frame ring (renderer lib/renderer-diagnostics.ts):
// what one Long Animation Frames entry keeps (file names only, the top
// scripts), the ring bound, and the per-minute drain main logs.
import { describe, expect, it } from "vitest";
import {
  createFrameRing,
  scriptFileName,
  toLongFrame,
} from "../src/renderer/src/lib/renderer-diagnostics";

describe("long frames", () => {
  it("keeps a frame's timing and its three slowest scripts, by file name only", () => {
    const frame = toLongFrame(
      {
        startTime: 1_500,
        duration: 182.4,
        blockingDuration: 132.2,
        scripts: [
          {
            invoker: "TimerHandler:setTimeout",
            sourceURL:
              "file:///Users/me/app/out/renderer/assets/index-abc.js?v=1",
            sourceFunctionName: "renderRows",
            duration: 120.6,
          },
          {
            invoker: "a",
            sourceURL: "x.js",
            sourceFunctionName: "small",
            duration: 1,
          },
          {
            invoker: "b",
            sourceURL: "y.js",
            sourceFunctionName: "mid",
            duration: 30,
          },
          {
            invoker: "c",
            sourceURL: "z.js",
            sourceFunctionName: "other",
            duration: 10,
          },
        ],
      },
      1_700_000_000_000,
    );
    expect(frame).toEqual({
      at: new Date(1_700_000_001_500).toISOString(),
      ms: 182,
      blockingMs: 132,
      scripts: [
        {
          invoker: "TimerHandler:setTimeout",
          source: "index-abc.js",
          fn: "renderRows",
          ms: 121,
        },
        { invoker: "b", source: "y.js", fn: "mid", ms: 30 },
        { invoker: "c", source: "z.js", fn: "other", ms: 10 },
      ],
    });
    expect(scriptFileName(undefined)).toBe("");
  });

  it("bounds the ring and drains the per-minute count and worst", () => {
    const ring = createFrameRing(2);
    for (const ms of [60, 300, 90]) {
      ring.add({ at: "", ms, blockingMs: 0, scripts: [] });
    }
    expect(ring.frames().map((frame) => frame.ms)).toEqual([300, 90]);
    expect(ring.drain()).toEqual({ long: 3, maxMs: 300 });
    expect(ring.drain()).toEqual({ long: 0, maxMs: 0 });
  });
});
