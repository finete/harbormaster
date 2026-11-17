// Turn boundaries (docs/harness-additions.md S5): a harness's own lifecycle
// hooks say "the turn is over" (`stop`) or "a turn is running" (`prompt`:
// a prompt was submitted, `tool`: a tool just ran), independent of the
// wording of its OSC 7501 messages. Claude Code's per-session hooks report
// them (`harbormaster hook inbox`); Pi reports none, so nothing here ever
// applies to it. Pure: no I/O, no clock.

import type { TurnBoundaryKind } from "../contracts/commands.js";
import type { ProgramStatusReading } from "../contracts/harness.js";

export const TURN_BOUNDARY_KINDS: readonly TurnBoundaryKind[] = [
  "stop",
  "prompt",
  "tool",
];

/**
 * A program-status reading under the last turn boundary: `working` while
 * the last boundary is `stop` (no `prompt` / `tool` since) is the harness
 * lingering after its turn (Claude: background work still running), so it
 * is recorded as `idle`, message kept. Order-independent: the same verdict
 * whether the `working` report arrived before or after the `stop`.
 */
export function readingUnderTurnBoundary(
  reading: ProgramStatusReading,
  lastBoundary: TurnBoundaryKind | undefined,
): ProgramStatusReading {
  if (reading.state === "working" && lastBoundary === "stop") {
    return {
      state: "idle",
      ...(reading.message ? { message: reading.message } : {}),
    };
  }
  return reading;
}

/** Per-task tracking core keeps between reports and boundaries (one live process). */
export interface TurnTracking {
  /** The process the last report came from; a new pid resets the boundary. */
  pid?: number;
  /** The last report as the adapter interpreted it, before any boundary override. */
  reading?: ProgramStatusReading;
  lastBoundary?: TurnBoundaryKind;
  /** Hooks-reported presence (Cursor): the generation of the last `aborted` stop (harness/hook-presence.ts). */
  abortedGeneration?: string;
}

/** Tracking after a program-status report from `pid` (a new process forgets the old boundary). */
export function trackReport(
  current: TurnTracking | undefined,
  pid: number,
  reading: ProgramStatusReading,
): TurnTracking {
  const samePid = current?.pid === pid;
  return {
    pid,
    reading,
    ...(samePid && current?.lastBoundary
      ? { lastBoundary: current.lastBoundary }
      : {}),
  };
}

/** Tracking after a boundary; the pending reading (if any) is re-judged by the caller. */
export function trackBoundary(
  current: TurnTracking | undefined,
  kind: TurnBoundaryKind,
): TurnTracking {
  return { ...current, lastBoundary: kind };
}
