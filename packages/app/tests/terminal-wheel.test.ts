/**
 * Unit tests for the WheelAccumulator (P0-1).
 *
 * These test pure accumulation logic — no DOM, no xterm instance.
 * Acceptance numbers from the checklist §(c) P0-1 measurements table.
 */

import { describe, expect, it } from "vitest";
import { createWheelAccumulator } from "../src/renderer/src/lib/terminal-host/wheel";

const CELL_H = 15; // CSS px, as in the benchmark

function feed(
  acc: ReturnType<typeof createWheelAccumulator>,
  events: { deltaY: number; deltaMode?: 0 | 1 | 2 }[],
  rows = 50,
): number {
  let total = 0;
  for (const ev of events) {
    total += acc.consume({
      deltaY: ev.deltaY,
      deltaMode: (ev.deltaMode ?? 0) as 0 | 1 | 2,
      cellHeightPx: CELL_H,
      rows,
    });
  }
  return total;
}

describe("createWheelAccumulator – pixel mode (deltaMode 0)", () => {
  it("45 events decaying 60→1 px (620 px total) → 41", () => {
    // Simulate a trackpad flick profile: exponential decay from 60 px, 45 events
    // summing to ~620 px (the CDP-synthesised profile from the benchmark harness).
    // Precise values: 620 px / 15 px·cell⁻¹ ≈ 41.33 → trunc = 41.
    const acc = createWheelAccumulator();
    // Simple way to get exactly 620 px across 45 events: spread it as
    // floor(620/45)=13 px for 44 events + 48 px for the first event.
    // (13*44 + 48 = 572 + 48 = 620). This tests accumulation, not the
    // exact profile; the physics only cares about the total.
    const events: { deltaY: number }[] = [{ deltaY: 48 }];
    for (let i = 0; i < 44; i++) events.push({ deltaY: 13 });
    const total = feed(acc, events);
    // 620 / 15 = 41.33 → 41
    expect(total).toBe(41);
  });

  it("60 × 3 px events → 12", () => {
    const acc = createWheelAccumulator();
    const events = Array.from({ length: 60 }, () => ({ deltaY: 3 }));
    expect(feed(acc, events)).toBe(12);
  });

  it("10 × 100 px events → 66 (carry ~0.67)", () => {
    const acc = createWheelAccumulator();
    const events = Array.from({ length: 10 }, () => ({ deltaY: 100 }));
    // 1000 / 15 = 66.67, trunc = 66
    expect(feed(acc, events)).toBe(66);
  });

  it("direction flip resets carry", () => {
    const acc = createWheelAccumulator();
    // Send 7 px down (0.467 lines carry)
    acc.consume({ deltaY: 7, deltaMode: 0, cellHeightPx: CELL_H, rows: 50 });
    // Flip direction: carry should reset, so 7 px up builds from 0
    acc.consume({ deltaY: -7, deltaMode: 0, cellHeightPx: CELL_H, rows: 50 });
    // Now add enough to produce a line (16 px = 1 line at 15 px)
    const n = acc.consume({
      deltaY: -16,
      deltaMode: 0,
      cellHeightPx: CELL_H,
      rows: 50,
    });
    // After reset: -7 + -16 = -23 px → -1 line (carry -0.533)
    expect(n).toBe(-1);
  });

  it("clamps to ±100 per event", () => {
    const acc = createWheelAccumulator();
    // 2000 px / 15 ≈ 133, must be clamped to 100
    const n = acc.consume({
      deltaY: 2000,
      deltaMode: 0,
      cellHeightPx: CELL_H,
      rows: 50,
    });
    expect(n).toBe(100);
  });
});

describe("createWheelAccumulator – line mode (deltaMode 1)", () => {
  it("±3 line events pass through directly", () => {
    const acc = createWheelAccumulator();
    expect(
      acc.consume({ deltaY: 3, deltaMode: 1, cellHeightPx: CELL_H, rows: 50 }),
    ).toBe(3);
    expect(
      acc.consume({ deltaY: -3, deltaMode: 1, cellHeightPx: CELL_H, rows: 50 }),
    ).toBe(-3);
  });
});

describe("createWheelAccumulator – page mode (deltaMode 2)", () => {
  it("1 page event = rows lines", () => {
    const acc = createWheelAccumulator();
    const rows = 40;
    expect(
      acc.consume({ deltaY: 1, deltaMode: 2, cellHeightPx: CELL_H, rows }),
    ).toBe(40);
  });

  it("-1 page event = -rows lines", () => {
    const acc = createWheelAccumulator();
    const rows = 25;
    expect(
      acc.consume({ deltaY: -1, deltaMode: 2, cellHeightPx: CELL_H, rows }),
    ).toBe(-25);
  });
});

describe("createWheelAccumulator – reset()", () => {
  it("reset clears fractional carry", () => {
    const acc = createWheelAccumulator();
    // Build up 0.8 lines of carry (12 px out of 15)
    acc.consume({ deltaY: 12, deltaMode: 0, cellHeightPx: CELL_H, rows: 50 });
    acc.reset();
    // After reset, 12 px should start fresh (not get an extra 0.8 head start)
    const n = acc.consume({
      deltaY: 12,
      deltaMode: 0,
      cellHeightPx: CELL_H,
      rows: 50,
    });
    expect(n).toBe(0); // 12/15 = 0.8, trunc = 0
  });
});
