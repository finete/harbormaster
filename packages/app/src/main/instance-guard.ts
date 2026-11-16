// Single-instance guard: one Harbormaster per state dir. Two hosts on the
// same `~/.harbormaster` split the world: the first keeps the tool socket,
// so every CLI/hook call (inbox hooks, `harbormaster open-url`, Review) is
// served by its (possibly stale) core while the second runs without one.
// So a starting app never runs without the socket:
//
// - Electron's single-instance lock (keyed by the userData dir) catches a
//   duplicate of the same app: the holder gets `second-instance` and
//   focuses its window; this one quits.
// - The socket ping catches a different build on the same state dir (dev
//   vs packaged, an older release): a blocking "already running" dialog
//   with Quit / Retry, never a silent start.
//
// Pure decisions here (tests/instance-guard.test.ts); main/index.ts runs
// the probe, the dialog and the quit.

import type { SocketOwner } from "@harbormaster/core";

export type StartupDecision =
  /** Nobody else serves this state dir: start (and take the socket). */
  | { action: "start" }
  /** A duplicate of this app: the lock holder focuses itself; quit quietly. */
  | { action: "quit-duplicate" }
  /** Another host owns the socket: block until it quits (dialog Quit / Retry). */
  | { action: "block"; message: string };

export function decideStartup(input: {
  /** `app.requestSingleInstanceLock()`. */
  gotLock: boolean;
  /** Who answers on this state dir's socket. */
  owner: SocketOwner;
  ownVersion: string;
}): StartupDecision {
  const { gotLock, owner, ownVersion } = input;
  if (!gotLock) {
    // The lock holder is this same app (same userData); a socket it serves
    // with our version is that holder (or it is still starting): it will
    // focus itself. A different version on the socket is someone else.
    if (owner.state !== "live" || owner.version === ownVersion) {
      return { action: "quit-duplicate" };
    }
    return { action: "block", message: alreadyRunningMessage(owner) };
  }
  if (owner.state === "none") return { action: "start" };
  // We hold the lock, so whoever answers is another build (different
  // userData) on the same state dir: even the same version is not us.
  return { action: "block", message: alreadyRunningMessage(owner) };
}

/** "Harbormaster <v> is already running (pid N); quit it to continue." */
export function alreadyRunningMessage(owner: SocketOwner): string {
  if (owner.state === "unresponsive") {
    return "Another Harbormaster is already running (it is not responding); quit it to continue.";
  }
  const version =
    owner.state === "live" && owner.version
      ? `Harbormaster ${owner.version}`
      : "An older Harbormaster";
  const pid =
    owner.state === "live" && owner.pid !== undefined
      ? ` (pid ${owner.pid})`
      : "";
  return `${version} is already running${pid}; quit it to continue.`;
}

/** The one main.log line per decision. */
export function describeStartupDecision(
  decision: StartupDecision,
  input: { gotLock: boolean; owner: SocketOwner },
): string {
  const owner =
    input.owner.state === "live"
      ? `live${input.owner.version ? ` ${input.owner.version}` : ""}${
          input.owner.pid !== undefined ? ` pid ${input.owner.pid}` : ""
        }`
      : input.owner.state;
  return `[instance] lock=${input.gotLock ? "held" : "taken"} socket=${owner} -> ${decision.action}`;
}
