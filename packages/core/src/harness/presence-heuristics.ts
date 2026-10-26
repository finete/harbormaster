// Pure liveness heuristics shared by harness adapters. Ported from
// pi-home's src/engines/presence.ts (PRESENCE_STALE_MS / presenceIsLive),
// generalized into the `PresenceStatus` shape this package's harness
// contract exposes. Stateless by design (Engine layer per
// /docs/design-decisions.md "Layering"): no I/O, only a record + clock + optional pid
// probe in, a liveness verdict out.

import type { PresenceStatus } from "../contracts/harness.js";
import type { PresenceRecord } from "../contracts/model.js";

/**
 * A heartbeat older than this is treated as a dead process (crash, kill,
 * reboot). Three missed 60s heartbeats keeps false "attention" flags rare
 * while still surfacing silent deaths within minutes.
 */
export const PRESENCE_STALE_MS = 3 * 60_000;

export interface PresenceLivenessOptions {
  staleMs?: number;
  /**
   * Optional process probe. Heartbeats are the portable signal, but a
   * process that no longer exists cannot be working — probing turns a run
   * that died before its first heartbeat (crash at startup, kill, reboot)
   * into an immediate signal instead of a multi-minute wait for staleness.
   */
  isAlive?: (pid: number) => boolean;
}

function heartbeatFresh(
  record: PresenceRecord,
  now: Date,
  options: PresenceLivenessOptions,
): boolean {
  if (options.isAlive && !options.isAlive(record.pid)) return false;
  return (
    now.getTime() - Date.parse(record.heartbeatAt) <
    (options.staleMs ?? PRESENCE_STALE_MS)
  );
}

/** Whether the process behind a record is alive: no reported end, and a fresh heartbeat (or probe). */
export function presenceIsLive(
  record: PresenceRecord | undefined,
  now: Date,
  options: PresenceLivenessOptions = {},
): boolean {
  return !!record && !record.ended && heartbeatFresh(record, now, options);
}

/** Derive the full `PresenceStatus` a harness adapter returns from a raw record. */
export function derivePresenceStatus(
  record: PresenceRecord | undefined,
  now: Date,
  options: PresenceLivenessOptions = {},
): PresenceStatus {
  const live = presenceIsLive(record, now, options);
  return {
    live,
    ...(record ? { record } : {}),
    runningTurn: live && !!record?.runningTurn,
  };
}
