// Electron wiring for the performance/health logging (health-monitor.ts,
// pass-timer.ts, ipc-timing.ts, pty-traffic.ts), the main-process CPU
// profiler (cpu-profile.ts: automatic on lag or CPU, manual from the Help
// menu), the renderer's long-frame counts and the crash sentinel
// (run-sentinel.ts), kept out of main/index.ts so it only needs a couple
// of one-line calls. All the logic lives in those pure modules.
import { join } from "node:path";
import { app, BrowserWindow, type IpcMain } from "electron";
import {
  AUTO_PROFILE_MS,
  createCpuWindow,
  createMainProfiler,
  createProfileTrigger,
  MANUAL_PROFILE_MS,
  type MainProfiler,
  PROFILES_DIR_NAME,
} from "./cpu-profile";
import {
  type FrameStats,
  type HealthMonitor,
  startHealthMonitor,
} from "./health-monitor";
import { ipcTiming } from "./ipc-timing";
import { passTimer } from "./pass-timer";
import { ptyTraffic } from "./pty-traffic";
import { sessionCounts } from "./ptySessions";
import { SENTINEL_FILE_NAME, startRunSentinel } from "./run-sentinel";

/** Wraps every later `ipcMain.handle` registration with timing / in-flight tracking. Call before any handler registers. */
export function installIpcTiming(ipcMain: IpcMain): void {
  ipcTiming.install(ipcMain);
}

/**
 * Checks for (and logs) a previous run's leftover sentinel, writes this
 * run's, and removes it on a clean `will-quit`. Call after the log tee is
 * installed so its lines land in main.log.
 */
export function installRunSentinel(): void {
  const sentinel = startRunSentinel({
    path: join(app.getPath("userData"), "logs", SENTINEL_FILE_NAME),
    pid: process.pid,
    version: app.getVersion(),
  });
  app.on("will-quit", () => sentinel.markCleanExit());
}

let monitor: HealthMonitor | undefined;
let profiler: MainProfiler | undefined;
/** How often main's CPU is sampled for the profiler's CPU trigger. */
const CPU_SAMPLE_MS = 5_000;

/** Where profiles are kept (`<userData>/logs/profiles`), read by Export diagnostics. */
export function profilesDir(): string {
  return join(app.getPath("userData"), "logs", PROFILES_DIR_NAME);
}

function mainProfiler(): MainProfiler {
  profiler ??= createMainProfiler({
    dir: profilesDir(),
    log: (line) => console.log(line),
  });
  return profiler;
}

/** The Help menu's "Profile Main Process (10 s)": resolves the saved file, or null (one already running, or it failed). */
export function profileMainNow(): Promise<string | null> {
  // e2e shortens it (HARBORMASTER_MANUAL_PROFILE_MS); the app never sets it.
  const override = Number(process.env.HARBORMASTER_MANUAL_PROFILE_MS);
  const durationMs =
    Number.isFinite(override) && override > 0 ? override : MANUAL_PROFILE_MS;
  return mainProfiler().profile("manual", durationMs);
}

// The renderer's long animation frames, reported once a minute
// (renderer lib/long-frames.ts), summed until the next health line.
let frames: FrameStats | undefined;

/** One renderer report (`app:frameStats`); bad input is ignored. */
export function recordFrameStats(stats: unknown): void {
  if (typeof stats !== "object" || stats === null) return;
  const { long, maxMs } = stats as Record<string, unknown>;
  if (typeof long !== "number" || typeof maxMs !== "number") return;
  if (!Number.isFinite(long) || !Number.isFinite(maxMs) || long < 0) return;
  frames = {
    long: (frames?.long ?? 0) + Math.round(long),
    maxMs: Math.max(frames?.maxMs ?? 0, Math.round(maxMs)),
  };
}

function drainFrameStats(): FrameStats | undefined {
  const out = frames;
  frames = undefined;
  return out;
}

/** Starts the minutely `[health]` line and spike markers (once), emitting the first line right away. Needs app-ready (`getAppMetrics`). */
export function startMainHealthMonitor(): void {
  if (monitor) return;
  const trigger = createProfileTrigger();
  const autoProfile = (due: { trigger: "lag" | "cpu"; detail: string }) => {
    const profile = mainProfiler();
    if (profile.busy()) return;
    trigger.profiled(Date.now());
    void profile.profile(due.trigger, AUTO_PROFILE_MS, due.detail);
  };
  const cpuWindow = createCpuWindow();
  const cpuSampler = setInterval(() => {
    try {
      const now = Date.now();
      const { percent, coveredMs } = cpuWindow.sample(now, process.cpuUsage());
      const due = trigger.onCpu(percent, coveredMs, now);
      if (due) autoProfile(due);
    } catch {
      // Monitoring must never break the app.
    }
  }, CPU_SAMPLE_MS);
  cpuSampler.unref?.();
  monitor = startHealthMonitor({
    appMetrics: () => app.getAppMetrics(),
    memory: () => process.memoryUsage(),
    ptyCounts: sessionCounts,
    drainPtyTraffic: () => ptyTraffic.drainWindow(3),
    ptyBytesLastSecond: () => ptyTraffic.lastSecondBytes(),
    windowCount: () => BrowserWindow.getAllWindows().length,
    drainPassStats: () => passTimer.drainStats(),
    runningPasses: () => passTimer.running(),
    ipcInFlight: () => ipcTiming.inFlight(),
    ptyLifetimes: () => ptyTraffic.lifetime(),
    drainFrameStats,
    onLagSample: (lagMs, nowMs) => {
      const due = trigger.onLag(lagMs, nowMs);
      if (due) autoProfile(due);
    },
    log: (line) => console.log(line),
  });
  monitor.emit();
  app.on("will-quit", () => {
    monitor?.stop();
    clearInterval(cpuSampler);
  });
}
