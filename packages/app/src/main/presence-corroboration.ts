// Outside-observation corroboration for presence (see /AGENTS.md: "Agent
// harnesses are adapters" and the harness's own doc comments). The app is
// the pty parent of every pane's agent process: it always knows, for its
// own panes, the real child pid right now. The extension's presence record
// (read through `PiHarnessAdapter.presence`) is self-reported from
// *inside* that process and stays authoritative for semantics — turn
// state, outcomes, session capture. This module cross-checks the two:
// when the app's own ground truth about a pane disagrees with what the
// record claims, the record's turn/outcome semantics are distrusted (but
// its mere *existence* never is — a stale record pointing at a dead pid
// with no pane of ours is still someone else's live external session,
// exactly as today).
//
// Pure (Engine-layer: see /docs/design-decisions.md "Layering") — no I/O, no clock of
// its own; `status` is whatever `PiHarnessAdapter.presence()` already
// derived (heartbeat + its own pid-liveness probe), `pane` is a read of the
// app's own in-memory pty registry (see `ptySessions.ts`).

import type {
  PresenceOutcome,
  PresenceRecord,
  PresenceStatus,
} from "@harbormaster/core";

/**
 * How a presence push was corroborated against the app's own pty registry:
 * - `"record"`: the extension's record is trusted as-is (either its pid
 *   matches this task's pane, or there is no pane of ours and the record's
 *   own process is alive — an external session, e.g. ssh/terminal/adopted).
 * - `"pane-only"`: a pane of ours exists but the record's pid doesn't match
 *   it (stale record, impersonation, pre-guard leftovers) — the pane's
 *   physical existence is trusted, its semantics are not.
 * - `"none"`: nothing to trust — no pane, and the record is absent or its
 *   process is confirmed dead.
 */
export type Corroboration = "record" | "pane-only" | "none";

/** What the app itself knows about a task's primary pane right now. */
export interface PaneLookupResult {
  /** The pane's actual child pid (node-pty's own `IPty.pid`). */
  pid: number;
  /** Always `true` for a result returned today — the registry drops an entry the instant its process exits (see `ptySessions.ts`'s `lookupPanePid`) — kept explicit so a future "exited but not yet reaped" state has somewhere to live without a shape change. */
  alive: boolean;
}

/** The corroborated badge state pushed to every window (see `PresenceChangedPayload`). */
export interface CorroboratedPresence {
  live: boolean;
  runningTurn: boolean;
  corroboration: Corroboration;
  /** Last heartbeat of the live attachment, when a record's own semantics are trusted. Never forwarded for a `"pane-only"` verdict: a stale record's heartbeat belongs to a different process and would mislabel the relative-time column. */
  heartbeatAt?: string;
  /** Terminal outcome of a headless run, carried through whenever the record is trusted (`"record"` or a confirmed-dead `"none"`) so the UI still shows what happened. Never forwarded for `"pane-only"`: a live pane in front of the user is not "ended". */
  ended?: PresenceOutcome;
  /**
   * Live self-reported done/blocked verdict (see `PresenceRecord.outcome`)
   * while the process is STILL attached - distinct from `ended`, which
   * means the process is gone. Carried through under the same trust rule
   * as `ended`: forwarded only when the record itself is trusted, never
   * for a `"pane-only"` verdict.
   */
  outcome?: { status: "done" | "blocked"; note?: string };
}

function endedFrom(ended: PresenceOutcome): PresenceOutcome {
  return { ...ended };
}

function outcomeFrom(outcome: NonNullable<PresenceRecord["outcome"]>): {
  status: "done" | "blocked";
  note?: string;
} {
  return {
    status: outcome.status,
    ...(outcome.note ? { note: outcome.note } : {}),
  };
}

/**
 * Derives the pushed badge state for one task from its extension-reported
 * presence status and the app's own pane-pid lookup for that task.
 *
 * - Pane exists AND `record.pid === pane.pid`: trust the record fully
 *   (`status.live`/`status.runningTurn`/`status.record?.ended` as today).
 * - Pane exists AND the pid differs (or there is no record at all): the
 *   pane is physically attached but its reported turn/outcome can't be
 *   trusted — report attached-neutral (`live: true, runningTurn: false`)
 *   instead of a possibly-false "working"/"your move".
 * - No pane, record's own process alive: an external session beyond this
 *   app's panes — trust it exactly as the harness already does (never
 *   regress this coverage).
 * - No pane, record's own process dead (or no record): idle immediately —
 *   `status.live` already reflects `PiHarnessAdapter`'s own pid-liveness
 *   probe, so this never waits out the heartbeat staleness window.
 */
export function corroboratePresence(
  status: PresenceStatus,
  pane: PaneLookupResult | undefined,
): CorroboratedPresence {
  const record = status.record;

  if (pane) {
    if (record && record.pid === pane.pid) {
      return {
        live: status.live,
        runningTurn: status.runningTurn,
        corroboration: "record",
        ...(status.live && record.heartbeatAt
          ? { heartbeatAt: record.heartbeatAt }
          : {}),
        ...(record.ended ? { ended: endedFrom(record.ended) } : {}),
        ...(record.outcome ? { outcome: outcomeFrom(record.outcome) } : {}),
      };
    }
    // A pane of ours exists, but the record either doesn't exist or points
    // at a different pid: trust the pane's existence, not the record's
    // stale/impersonated semantics.
    return { live: true, runningTurn: false, corroboration: "pane-only" };
  }

  if (!record) {
    return { live: false, runningTurn: false, corroboration: "none" };
  }

  if (status.live) {
    // No pane of ours, but the record's own process is alive: coverage
    // beyond our panes (ssh, a bare terminal, an adopted session) — trust
    // it exactly as `PiHarnessAdapter.presence()` already does.
    return {
      live: true,
      runningTurn: status.runningTurn,
      corroboration: "record",
      ...(record.heartbeatAt ? { heartbeatAt: record.heartbeatAt } : {}),
      ...(record.ended ? { ended: endedFrom(record.ended) } : {}),
      ...(record.outcome ? { outcome: outcomeFrom(record.outcome) } : {}),
    };
  }

  // No pane, and the record's process is not live (ended, or its pid is
  // confirmed dead): idle, carrying through any terminal outcome so the UI
  // still shows what happened.
  return {
    live: false,
    runningTurn: false,
    corroboration: "none",
    ...(record.ended ? { ended: endedFrom(record.ended) } : {}),
    ...(record.outcome ? { outcome: outcomeFrom(record.outcome) } : {}),
  };
}
