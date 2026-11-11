// Pure liveness heuristics shared by harness adapters. Ported from
// pi-home's src/engines/presence.ts (PRESENCE_STALE_MS / presenceIsLive),
// generalized into the `PresenceStatus` shape this package's harness
// contract exposes. Stateless by design (Engine layer per
// /docs/design-decisions.md "Layering"): no I/O, only a record + clock + optional pid
// probe in, a liveness verdict out.

import type { PresenceStatus } from "../contracts/harness.js";
import type { PresenceRecord } from "../contracts/model.js";
import type { ProgramState } from "../utilities/program-status.js";

/**
 * A heartbeat older than this is treated as a dead process (crash, kill,
 * reboot). Three missed 60s heartbeats keeps false "attention" flags rare
 * while still surfacing silent deaths within minutes.
 */
export const PRESENCE_STALE_MS = 3 * 60_000;

export interface PresenceLivenessOptions {
  staleMs?: number;
  /**
   * Optional process probe. When present, pid liveness IS the "ended"
   * signal (decision #18: status comes from OSC 7501 reports, which have no
   * heartbeat, so an idle agent may not report for hours): a record whose
   * process is alive is live, a dead one is not. Without a probe the
   * portable heartbeat-staleness rule applies.
   */
  isAlive?: (pid: number) => boolean;
}

function heartbeatFresh(
  record: PresenceRecord,
  now: Date,
  options: PresenceLivenessOptions,
): boolean {
  if (options.isAlive) return options.isAlive(record.pid);
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

/** One OSC 7501 report as core records it (see `CoreCommands.reportPresence`). */
export interface ProgramStatusInput {
  taskId: string;
  /** The reporting process (the pty's child): pid liveness is the "ended" signal. */
  pid: number;
  state: ProgramState;
  message?: string;
  at: string;
}

/**
 * The presence record after one program-status report (decision #18):
 * `working` = a turn is running (spinner); `blocked` = waiting on the user
 * ("your move"); `idle` / `done` = at rest; `error` = at rest with a
 * warning (the status message). A report from a different pid, or onto an
 * ended record, starts a fresh interactive attachment; a turn starting
 * again clears a previously reported outcome, exactly like
 * `PresenceAccess.setTurnActive`.
 */
export function applyProgramStatus(
  current: PresenceRecord | undefined,
  input: ProgramStatusInput,
): PresenceRecord {
  const base: PresenceRecord =
    current && current.pid === input.pid && !current.ended
      ? current
      : {
          taskId: input.taskId,
          sessionPath: "",
          pid: input.pid,
          mode: "interactive",
          startedAt: input.at,
          heartbeatAt: input.at,
        };
  const next: PresenceRecord = {
    ...base,
    heartbeatAt: input.at,
    runningTurn: input.state === "working",
    status: {
      state: input.state,
      ...(input.message ? { message: input.message } : {}),
      at: input.at,
    },
  };
  if (input.state === "working") delete next.outcome;
  return next;
}
