// Electron wiring for the performance/health logging (health-monitor.ts,
// pass-timer.ts, ipc-timing.ts, pty-traffic.ts) and the crash sentinel
// (run-sentinel.ts), kept out of main/index.ts so it only needs a couple
// of one-line calls. All the logic lives in those pure modules.
import { join } from "node:path";
import { app, BrowserWindow, type IpcMain } from "electron";
import { type HealthMonitor, startHealthMonitor } from "./health-monitor";
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

/** Starts the minutely `[health]` line and spike markers (once), emitting the first line right away. Needs app-ready (`getAppMetrics`). */
export function startMainHealthMonitor(): void {
  if (monitor) return;
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
    log: (line) => console.log(line),
  });
  monitor.emit();
  app.on("will-quit", () => monitor?.stop());
}
