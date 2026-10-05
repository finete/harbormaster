// Slim Pi extension — presence reporting only (wave 3b). Adoption commands,
// the temp write-guard, and the frozen TUI board are a later wave; see
// /docs/design-decisions.md and /AGENTS.md ("Agent harnesses are adapters").
//
// When a Harbormaster-launched Pi process starts (see
// `@harbormaster/core`'s `PiHarnessAdapter.buildLaunchSpec`, which sets
// `HARBORMASTER_TASK_ID` / `HARBORMASTER_STATE_DIR`), this extension
// registers presence, heartbeats on an interval, tracks turn boundaries, and
// ends its record on shutdown — the same liveness signal the core harness
// adapter's `presence()` reads back. Outside a Harbormaster-launched
// session (the env vars are absent — a bare `pi` run, or any other host)
// every hook below is a no-op.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveStatePaths, SessionPresenceAccess } from "@harbormaster/core";
import { PresenceReporter } from "./presence-reporter.js";

/** Idle heartbeat cadence; well under PRESENCE_STALE_MS (3 minutes) so a live process never looks dead. */
const HEARTBEAT_INTERVAL_MS = 60_000;

export default function harbormasterExtension(pi: ExtensionAPI): void {
  const taskId = process.env.HARBORMASTER_TASK_ID;
  const stateDir = process.env.HARBORMASTER_STATE_DIR;
  // Not a Harbormaster-hosted session (plain `pi`, or a non-Harbormaster
  // host): presence reporting has nothing to report against.
  if (!taskId || !stateDir) return;

  const presence = new SessionPresenceAccess(
    resolveStatePaths(stateDir).presenceDir,
  );
  const reporter = new PresenceReporter({ presence, pid: process.pid });

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) return;
    const mode = ctx.hasUI ? ("interactive" as const) : ("headless" as const);
    await reporter.start({ taskId, sessionPath, mode }).catch(() => {});
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      void reporter.heartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
  });

  pi.on("turn_start", async () => {
    await reporter.setTurnActive(true).catch(() => {});
  });
  pi.on("turn_end", async () => {
    await reporter.setTurnActive(false).catch(() => {});
  });

  pi.on("session_before_switch", async () => {
    stopHeartbeat();
    await reporter.end().catch(() => {});
    return undefined;
  });
  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    await reporter.end().catch(() => {});
  });
}
