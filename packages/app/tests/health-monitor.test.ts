import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  formatHealthLine,
  formatSpikeLine,
  HEALTH_LINE_MAX_CHARS,
  type HealthSnapshot,
  lagStats,
  MAX_LAG_SAMPLES,
  recordLagSample,
  SPIKE_MIN_GAP_MS,
  summarizeAppMetrics,
} from "../src/main/health-monitor";

describe("lagStats", () => {
  it("is all zeros for no samples", () => {
    expect(lagStats([])).toEqual({ p50: 0, p95: 0, max: 0, n: 0 });
  });

  it("computes nearest-rank p50/p95 and max regardless of order", () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1
    expect(lagStats(samples)).toEqual({ p50: 50, p95: 95, max: 100, n: 100 });
  });

  it("rounds to whole milliseconds", () => {
    expect(lagStats([1.4, 2.6])).toEqual({ p50: 1, p95: 3, max: 3, n: 2 });
  });
});

describe("summarizeAppMetrics", () => {
  it("buckets Electron process types and sums memory (KB→MB) and cpu", () => {
    const summary = summarizeAppMetrics([
      {
        type: "Browser",
        cpu: { percentCPUUsage: 3 },
        memory: { workingSetSize: 200 * 1024 },
      },
      {
        type: "Tab",
        cpu: { percentCPUUsage: 10.04 },
        memory: { workingSetSize: 300 * 1024 },
      },
      {
        type: "Tab",
        cpu: { percentCPUUsage: 5 },
        memory: { workingSetSize: 100 * 1024 },
      },
      {
        type: "GPU",
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 50 * 1024 },
      },
      {
        type: "Utility",
        cpu: { percentCPUUsage: 0 },
        memory: { workingSetSize: 20 * 1024 },
      },
      {
        type: "Zygote",
        cpu: { percentCPUUsage: 0 },
        memory: { workingSetSize: 1024 },
      },
    ]);
    expect(summary).toEqual({
      browser: { n: 1, memMb: 200, cpu: 3 },
      renderer: { n: 2, memMb: 400, cpu: 15 },
      gpu: { n: 1, memMb: 50, cpu: 1 },
      utility: { n: 1, memMb: 20, cpu: 0 },
      other: { n: 1, memMb: 1, cpu: 0 },
    });
  });
});

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    lag: { p50: 2, p95: 8, max: 40, n: 600 },
    rssMb: 210,
    heapMb: 90,
    procs: { renderer: { n: 1, memMb: 300, cpu: 4 } },
    ptys: { live: 3, attached: 1 },
    ptyBytes: 123_456,
    topPtys: [
      { sessionId: "s1", taskId: "t1", bytes: 100_000 },
      { sessionId: "s2", taskId: undefined, bytes: 20_000 },
      { sessionId: "s3", taskId: "t3", bytes: 3_000 },
      { sessionId: "s4", taskId: "t4", bytes: 456 },
    ],
    windows: 1,
    passes: { presence: { n: 12, maxMs: 30, totalMs: 120, failed: 0 } },
    ...overrides,
  };
}

describe("formatHealthLine", () => {
  it("prints compact JSON with the top 3 ptys and pass stats", () => {
    const line = formatHealthLine(snapshot());
    expect(line.startsWith("[health] {")).toBe(true);
    const parsed = JSON.parse(line.slice("[health] ".length));
    expect(parsed.lagMs).toEqual({ p50: 2, p95: 8, max: 40 });
    expect(parsed.ptys).toEqual({ live: 3, attached: 1 });
    expect(parsed.topPtys).toEqual([
      { id: "s1", task: "t1", bytes: 100_000 },
      { id: "s2", task: "-", bytes: 20_000 },
      { id: "s3", task: "t3", bytes: 3_000 },
    ]);
    expect(parsed.passes).toEqual({ presence: { n: 12, maxMs: 30 } });
    expect(parsed.windows).toBe(1);
  });

  it("stays within its size bound, shedding pass stats first", () => {
    const passes = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `pass-with-a-long-name-${i}`,
        { n: 1, maxMs: 1, totalMs: 1, failed: 1 },
      ]),
    );
    const line = formatHealthLine(snapshot({ passes }));
    expect(line.length).toBeLessThanOrEqual(HEALTH_LINE_MAX_CHARS);
    const parsed = JSON.parse(line.slice("[health] ".length));
    expect(parsed.passes).toBeUndefined();
    expect(parsed.topPtys).toHaveLength(3);
  });

  it("hard-truncates as a last resort", () => {
    expect(formatHealthLine(snapshot(), 50).length).toBe(50);
  });
});

describe("spike detection", () => {
  it("rate-limits to one per gap", () => {
    const allow = createRateLimiter(SPIKE_MIN_GAP_MS);
    expect(allow(1_000)).toBe(true);
    expect(allow(5_000)).toBe(false);
    expect(allow(1_000 + SPIKE_MIN_GAP_MS - 1)).toBe(false);
    expect(allow(1_000 + SPIKE_MIN_GAP_MS)).toBe(true);
  });

  it("flags only over-threshold lag, rate-limited, and records every sample", () => {
    const samples: number[] = [];
    const allow = createRateLimiter(10_000);
    expect(recordLagSample(samples, 5, 0, allow)).toBe(false);
    expect(recordLagSample(samples, 300, 100, allow)).toBe(true);
    expect(recordLagSample(samples, 900, 200, allow)).toBe(false); // limited
    expect(recordLagSample(samples, 260, 10_200, allow)).toBe(true);
    expect(recordLagSample(samples, -3, 10_300, allow)).toBe(false);
    expect(samples).toEqual([5, 300, 900, 260, 0]);
  });

  it("ignores a sleep-sized gap entirely", () => {
    const samples: number[] = [];
    expect(recordLagSample(samples, 3_600_000, 0, createRateLimiter())).toBe(
      false,
    );
    expect(samples).toEqual([]);
  });

  it("keeps the sample buffer bounded", () => {
    const samples: number[] = [];
    const allow = () => false;
    for (let i = 0; i < MAX_LAG_SAMPLES + 10; i++) {
      recordLagSample(samples, i, i, allow);
    }
    expect(samples).toHaveLength(MAX_LAG_SAMPLES);
    expect(samples[0]).toBe(10);
  });

  it("formats a spike line with capped lists", () => {
    const line = formatSpikeLine({
      lagMs: 412.7,
      ipcInFlight: Array.from({ length: 20 }, (_, i) => `ch${i}`),
      passes: ["presence", "refresh"],
      ptyBytes1s: 9_000,
    });
    const parsed = JSON.parse(line.slice("[health] spike ".length));
    expect(parsed.lagMs).toBe(413);
    expect(parsed.ipcInFlight).toHaveLength(10);
    expect(parsed.passes).toEqual(["presence", "refresh"]);
    expect(parsed.ptyBytes1s).toBe(9_000);
  });
});
