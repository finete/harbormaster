// CPU profiles of the main process, saved for Export diagnostics. The
// health line says *that* main is slow (lag, CPU); a profile says *which
// function*. Taken automatically when main lags or burns CPU (the
// JetBrains / VS Code pattern: catch the slowdown, profile it in-process),
// or on demand from the Help menu ("Profile Main Process (10 s)").
//
// How: an in-process V8 inspector session on the main thread
// (`inspector.Session.connect()`, Profiler domain). V8's sampler runs on
// its own thread, so a busy main is still sampled; only start and stop
// need main to get a turn, which even a lagging main gets between frames.
// No debug port is opened and no external tool (`sample`, `ps -M`) runs:
// nothing an EDR agent such as SentinelOne would flag, and no admin
// prompt. (A worker driving it through `connectToMainThread()` was tried
// first: `Profiler.start` never answers while main is idle, in Node 24
// and in Electron 33's main process alike.) A profile is a `.cpuprofile` (Chrome
// DevTools / VS Code / speedscope open it) in `<userData>/logs/profiles/`;
// only the newest `PROFILES_KEPT` stay. Automatic profiles are silent: one
// `[profile]` line in main.log.
//
// Trigger rules (pure, `createProfileTrigger`): event-loop lag p95 over
// `LAG_TRIGGER.p95Ms` across a full `LAG_TRIGGER.windowMs`, or main CPU
// over `CPU_TRIGGER.percent` across a full `CPU_TRIGGER.windowMs`; then
// nothing automatic for `PROFILE_COOLDOWN_MS`. The manual profile ignores
// the cooldown.

import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";

export const PROFILES_DIR_NAME = "profiles";
export const PROFILES_KEPT = 3;
export const AUTO_PROFILE_MS = 5_000;
export const MANUAL_PROFILE_MS = 10_000;
export const PROFILE_COOLDOWN_MS = 10 * 60_000;
export const LAG_TRIGGER = { p95Ms: 100, windowMs: 10_000 } as const;
export const CPU_TRIGGER = { percent: 80, windowMs: 60_000 } as const;
/** Sampling interval handed to V8's profiler (µs). */
const SAMPLING_INTERVAL_US = 1_000;

export type ProfileTrigger = "lag" | "cpu" | "manual";

export interface ProfileDue {
  trigger: Exclude<ProfileTrigger, "manual">;
  /** Why, for the `[profile]` line, e.g. "main 97% CPU over 60 s". */
  detail: string;
}

/** `2026-11-19T14-05-12-123Z-cpu.cpuprofile`: sortable, names its trigger. */
export function profileFileName(at: Date, trigger: ProfileTrigger): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${trigger}.cpuprofile`;
}

export interface SavedProfile {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** The saved profiles, newest first (missing dir = none). */
export function listProfiles(dir: string): SavedProfile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SavedProfile[] = [];
  for (const name of names) {
    if (!name.endsWith(".cpuprofile")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      out.push({ name, path, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Raced with a prune.
    }
  }
  return out.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name),
  );
}

/** Deletes all but the newest `keep` profiles. */
export function pruneProfiles(dir: string, keep: number = PROFILES_KEPT): void {
  for (const old of listProfiles(dir).slice(keep)) {
    try {
      unlinkSync(old.path);
    } catch {
      // Already gone.
    }
  }
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ??
    0
  );
}

export interface ProfileTriggerOptions {
  lag?: { p95Ms: number; windowMs: number };
  cpu?: { percent: number; windowMs: number };
  cooldownMs?: number;
}

export interface ProfileTriggerState {
  /** One event-loop lag sample; returns a due profile, or null. */
  onLag(lagMs: number, nowMs: number): ProfileDue | null;
  /**
   * Main's CPU % over the trailing `coveredMs` (the caller's sampler);
   * returns a due profile, or null.
   */
  onCpu(percent: number, coveredMs: number, nowMs: number): ProfileDue | null;
  /** A profile started (any trigger): restart the cooldown. */
  profiled(nowMs: number): void;
}

/**
 * When an automatic profile is due. Lag: the p95 of the samples within the
 * last `windowMs` (evaluated at most once a second, only once samples span
 * most of the window) is over `p95Ms`. CPU: the caller's percentage covers
 * the full window and is over `percent`. Neither fires within `cooldownMs`
 * of the last profile.
 */
export function createProfileTrigger(
  options: ProfileTriggerOptions = {},
): ProfileTriggerState {
  const lag = options.lag ?? LAG_TRIGGER;
  const cpu = options.cpu ?? CPU_TRIGGER;
  const cooldownMs = options.cooldownMs ?? PROFILE_COOLDOWN_MS;
  const samples: Array<{ at: number; lag: number }> = [];
  let lastProfileAt = Number.NEGATIVE_INFINITY;
  let lastLagCheck = Number.NEGATIVE_INFINITY;
  const cooling = (nowMs: number): boolean =>
    nowMs - lastProfileAt < cooldownMs;

  return {
    onLag(lagMs, nowMs) {
      samples.push({ at: nowMs, lag: lagMs });
      while (
        samples.length > 0 &&
        (samples[0]?.at ?? 0) < nowMs - lag.windowMs
      ) {
        samples.shift();
      }
      if (nowMs - lastLagCheck < 1_000) return null;
      lastLagCheck = nowMs;
      const oldest = samples[0]?.at ?? nowMs;
      if (nowMs - oldest < lag.windowMs * 0.9) return null;
      const value = p95(samples.map((sample) => sample.lag));
      if (value <= lag.p95Ms || cooling(nowMs)) return null;
      return {
        trigger: "lag",
        detail: `event-loop lag p95 ${Math.round(value)} ms over ${Math.round(lag.windowMs / 1000)} s`,
      };
    },
    onCpu(percent, coveredMs, nowMs) {
      if (coveredMs < cpu.windowMs || percent <= cpu.percent) return null;
      if (cooling(nowMs)) return null;
      return {
        trigger: "cpu",
        detail: `main ${Math.round(percent)}% CPU over ${Math.round(coveredMs / 1000)} s`,
      };
    },
    profiled(nowMs) {
      lastProfileAt = nowMs;
    },
  };
}

/**
 * Main's CPU % over a trailing window from `process.cpuUsage()` samples
 * (user + system µs, every thread of the process, so > 100% is possible).
 */
export function createCpuWindow(windowMs: number = CPU_TRIGGER.windowMs): {
  sample(
    nowMs: number,
    usage: { user: number; system: number },
  ): {
    percent: number;
    coveredMs: number;
  };
} {
  const points: Array<{ at: number; micros: number }> = [];
  return {
    sample(nowMs, usage) {
      points.push({ at: nowMs, micros: usage.user + usage.system });
      // Keep one point at or before the window start, so it can be covered.
      while (points.length > 2 && (points[1]?.at ?? 0) <= nowMs - windowMs) {
        points.shift();
      }
      const first = points[0];
      if (!first || first.at === nowMs) return { percent: 0, coveredMs: 0 };
      const coveredMs = nowMs - first.at;
      const usedMs = (usage.user + usage.system - first.micros) / 1000;
      return { percent: (usedMs / coveredMs) * 100, coveredMs };
    },
  };
}

/** Profiles the main thread for `durationMs`; resolves the `.cpuprofile` JSON. */
export async function recordMainThreadProfile(
  durationMs: number,
): Promise<string> {
  const session = new Session();
  session.connect();
  const post = <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      session.post(method, params, (error, result) =>
        error ? reject(error) : resolve(result as T),
      );
    });
  try {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", {
      interval: SAMPLING_INTERVAL_US,
    });
    await post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const { profile } = await post<{ profile: unknown }>("Profiler.stop");
    await post("Profiler.disable");
    return JSON.stringify(profile);
  } finally {
    session.disconnect();
  }
}

export interface MainProfiler {
  /**
   * Profiles main for `durationMs` and saves it; resolves the file path,
   * or null when a profile is already running or it failed (logged).
   */
  profile(
    trigger: ProfileTrigger,
    durationMs: number,
    detail?: string,
  ): Promise<string | null>;
  busy(): boolean;
}

export function createMainProfiler(options: {
  dir: string;
  log: (line: string) => void;
  keep?: number;
  record?: (durationMs: number) => Promise<string>;
  now?: () => Date;
}): MainProfiler {
  const record = options.record ?? recordMainThreadProfile;
  const now = options.now ?? (() => new Date());
  let running = false;
  return {
    busy: () => running,
    async profile(trigger, durationMs, detail) {
      if (running) return null;
      running = true;
      const startedAt = now();
      try {
        const json = await record(durationMs);
        mkdirSync(options.dir, { recursive: true });
        const name = profileFileName(startedAt, trigger);
        const path = join(options.dir, name);
        await writeFile(path, json);
        pruneProfiles(options.dir, options.keep ?? PROFILES_KEPT);
        options.log(
          `[profile] saved ${name} (trigger: ${trigger}${detail ? `, ${detail}` : ""}; ${Math.round(durationMs / 1000)} s, ${Math.round(json.length / 1024)} KB)`,
        );
        return path;
      } catch (error) {
        options.log(
          `[profile] failed (trigger: ${trigger}): ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      } finally {
        running = false;
      }
    },
  };
}
