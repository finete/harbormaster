// Minutely `[health] {...}` lines and `[health] spike {...}` markers in
// main.log, so "the app feels slow during long tasks" leaves numbers
// behind: event-loop lag, memory, Electron's per-process metrics, pty
// counts and output volume, open windows and the heavy passes' timings.
//
// Lag comes from a 100 ms drift sampler (an `unref()`d interval measuring
// how late each tick fires). A tick later than `spikeMs` (250 ms) means
// the main thread was blocked: a spike line names what was going on — IPC
// handlers in flight (ipc-timing.ts), passes running (pass-timer.ts) and
// pty bytes in the last second (pty-traffic.ts) — at most once per 10 s.
//
// Everything is pure (stats, metric summaries, formatting, rate limiting)
// except `startHealthMonitor`, which wires those to timers and injectable
// sources.
import type { PassStats } from "./pass-timer";
import type { PtyTrafficEntry, PtyTrafficWindow } from "./pty-traffic";

export const HEALTH_INTERVAL_MS = 60_000;
export const LAG_SAMPLE_MS = 100;
export const SPIKE_LAG_MS = 250;
export const SPIKE_MIN_GAP_MS = 10_000;
/** A health line is cut down to fit this many characters. */
export const HEALTH_LINE_MAX_CHARS = 1_500;
/** A tick later than this is a suspended machine (lid closed), not a blocked loop: ignored. */
export const MAX_PLAUSIBLE_LAG_MS = 30_000;
/** Lag samples kept per window: a 100 ms sampler makes ~600 a minute; beyond this the oldest go. */
export const MAX_LAG_SAMPLES = 2_000;

export interface LagStats {
  p50: number;
  p95: number;
  max: number;
  /** Samples the stats cover. */
  n: number;
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

/** p50/p95/max of lag samples (ms, rounded); zeros for none. */
export function lagStats(samples: readonly number[]): LagStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    n: sorted.length,
  };
}

/** The slice of Electron's `ProcessMetric` this reads (`app.getAppMetrics()`). */
export interface ProcessMetricLike {
  type: string;
  cpu: { percentCPUUsage: number };
  /** Kilobytes. */
  memory: { workingSetSize: number };
}

export interface ProcessGroupSummary {
  n: number;
  memMb: number;
  cpu: number;
}

export type ProcessGroup = "browser" | "renderer" | "gpu" | "utility" | "other";

/** Electron process types bucketed into the groups a health line reports, with summed memory (MB) and CPU (%). */
export function summarizeAppMetrics(
  metrics: readonly ProcessMetricLike[],
): Partial<Record<ProcessGroup, ProcessGroupSummary>> {
  const groupOf = (type: string): ProcessGroup => {
    if (type === "Browser") return "browser";
    if (type === "Tab") return "renderer";
    if (type === "GPU") return "gpu";
    if (type === "Utility") return "utility";
    return "other";
  };
  const out: Partial<Record<ProcessGroup, ProcessGroupSummary>> = {};
  for (const metric of metrics) {
    const group = groupOf(metric.type);
    const entry = out[group] ?? { n: 0, memMb: 0, cpu: 0 };
    out[group] = entry;
    entry.n += 1;
    entry.memMb += (metric.memory?.workingSetSize ?? 0) / 1024;
    entry.cpu += metric.cpu?.percentCPUUsage ?? 0;
  }
  for (const entry of Object.values(out)) {
    entry.memMb = Math.round(entry.memMb);
    entry.cpu = Math.round(entry.cpu * 10) / 10;
  }
  return out;
}

export interface HealthSnapshot {
  lag: LagStats;
  rssMb: number;
  heapMb: number;
  procs: Partial<Record<ProcessGroup, ProcessGroupSummary>>;
  ptys: { live: number; attached: number };
  ptyBytes: number;
  topPtys: readonly PtyTrafficEntry[];
  windows: number;
  passes: Readonly<Record<string, PassStats>>;
}

function compactPasses(
  passes: Readonly<Record<string, PassStats>>,
): Record<string, { n: number; maxMs: number; failed?: number }> {
  const out: Record<string, { n: number; maxMs: number; failed?: number }> = {};
  for (const [name, s] of Object.entries(passes)) {
    out[name] = {
      n: s.n,
      maxMs: s.maxMs,
      ...(s.failed > 0 ? { failed: s.failed } : {}),
    };
  }
  return out;
}

/**
 * `[health] {...}` — compact JSON, never longer than `maxChars`: if it
 * would be, the pass stats go first, then the top-pty list, and as a last
 * resort the line is hard-truncated.
 */
export function formatHealthLine(
  snapshot: HealthSnapshot,
  maxChars: number = HEALTH_LINE_MAX_CHARS,
): string {
  const base = {
    lagMs: {
      p50: snapshot.lag.p50,
      p95: snapshot.lag.p95,
      max: snapshot.lag.max,
    },
    rssMb: snapshot.rssMb,
    heapMb: snapshot.heapMb,
    procs: snapshot.procs,
    ptys: snapshot.ptys,
    ptyBytes: snapshot.ptyBytes,
    windows: snapshot.windows,
  };
  const topPtys = snapshot.topPtys.slice(0, 3).map((entry) => ({
    id: entry.sessionId.slice(0, 40),
    task: (entry.taskId ?? "-").slice(0, 40),
    bytes: entry.bytes,
  }));
  const candidates = [
    { ...base, topPtys, passes: compactPasses(snapshot.passes) },
    { ...base, topPtys },
    base,
  ];
  for (const candidate of candidates) {
    const line = `[health] ${JSON.stringify(candidate)}`;
    if (line.length <= maxChars) return line;
  }
  return `[health] ${JSON.stringify(base)}`.slice(0, maxChars);
}

export interface SpikeInfo {
  lagMs: number;
  ipcInFlight: readonly string[];
  passes: readonly string[];
  ptyBytes1s: number;
}

/** `[health] spike {...}`, list fields capped so a pathological moment can't produce a huge line. */
export function formatSpikeLine(spike: SpikeInfo): string {
  return `[health] spike ${JSON.stringify({
    lagMs: Math.round(spike.lagMs),
    ipcInFlight: spike.ipcInFlight.slice(0, 10),
    passes: spike.passes.slice(0, 10),
    ptyBytes1s: spike.ptyBytes1s,
  })}`;
}

/** At most one `true` per `minGapMs`. */
export function createRateLimiter(
  minGapMs: number = SPIKE_MIN_GAP_MS,
): (nowMs: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (nowMs) => {
    if (nowMs - last < minGapMs) return false;
    last = nowMs;
    return true;
  };
}

/**
 * Lag sample bookkeeping for one drift tick: how late it fired (never
 * negative), appended to `samples` (bounded), and whether it is a spike
 * line to emit now (over threshold and not rate-limited). A gap longer
 * than `MAX_PLAUSIBLE_LAG_MS` is sleep, not lag, and is dropped.
 */
export function recordLagSample(
  samples: number[],
  lagMs: number,
  nowMs: number,
  allowSpike: (nowMs: number) => boolean,
  spikeMs: number = SPIKE_LAG_MS,
): boolean {
  if (lagMs > MAX_PLAUSIBLE_LAG_MS) return false;
  const lag = Math.max(0, lagMs);
  samples.push(lag);
  if (samples.length > MAX_LAG_SAMPLES) samples.shift();
  return lag > spikeMs && allowSpike(nowMs);
}

export interface HealthMonitorDeps {
  appMetrics: () => readonly ProcessMetricLike[];
  memory: () => { rss: number; heapUsed: number };
  ptyCounts: () => { live: number; attached: number };
  drainPtyTraffic: () => PtyTrafficWindow;
  ptyBytesLastSecond: () => number;
  windowCount: () => number;
  drainPassStats: () => Record<string, PassStats>;
  runningPasses: () => string[];
  ipcInFlight: () => string[];
  log: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
  sampleMs?: number;
}

export interface HealthMonitor {
  /** Emits one health line now (covering the window so far) and starts a new window. */
  emit(): void;
  stop(): void;
}

/** Starts the sampler and the minutely health line; both timers are `unref()`d. Emits nothing itself until `emit()` or the first interval. */
export function startHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const now = deps.now ?? (() => performance.now());
  const sampleMs = deps.sampleMs ?? LAG_SAMPLE_MS;
  const samples: number[] = [];
  const allowSpike = createRateLimiter();
  let expected = now() + sampleMs;

  const sampler = setInterval(() => {
    const t = now();
    const lag = t - expected;
    expected = t + sampleMs;
    try {
      if (recordLagSample(samples, lag, Date.now(), allowSpike)) {
        deps.log(
          formatSpikeLine({
            lagMs: lag,
            ipcInFlight: deps.ipcInFlight(),
            passes: deps.runningPasses(),
            ptyBytes1s: deps.ptyBytesLastSecond(),
          }),
        );
      }
    } catch {
      // Monitoring must never break the app.
    }
  }, sampleMs);
  sampler.unref?.();

  function emit(): void {
    try {
      const memory = deps.memory();
      const traffic = deps.drainPtyTraffic();
      const line = formatHealthLine({
        lag: lagStats(samples),
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapMb: Math.round(memory.heapUsed / 1024 / 1024),
        procs: summarizeAppMetrics(deps.appMetrics()),
        ptys: deps.ptyCounts(),
        ptyBytes: traffic.totalBytes,
        topPtys: traffic.top,
        windows: deps.windowCount(),
        passes: deps.drainPassStats(),
      });
      samples.length = 0;
      deps.log(line);
    } catch {
      // Monitoring must never break the app.
    }
  }

  const ticker = setInterval(emit, deps.intervalMs ?? HEALTH_INTERVAL_MS);
  ticker.unref?.();

  return {
    emit,
    stop: () => {
      clearInterval(sampler);
      clearInterval(ticker);
    },
  };
}
