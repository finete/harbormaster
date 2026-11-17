// Presence from lifecycle hooks (docs/harness-additions.md C3): for a
// harness that reports no program status on its pty (Cursor:
// `capabilities.status.protocol: "hooks"`), the launcher registers the
// attachment at spawn as `working` + `HOOK_PRESENCE_STARTING` and the
// hooks report the rest. Pure: no I/O, no clock.
//
// Mapping (verified on cursor-agent 2026.11.13):
// - `start` (sessionStart, or the pty settling on a resume, which fires no
//   sessionStart) → idle, but only while the attachment is still starting:
//   with a prompt on the command line Cursor fires sessionStart and
//   beforeSubmitPrompt at the same moment, in either order.
// - `prompt` (beforeSubmitPrompt, or a stop hook that handed Cursor a
//   follow-up: the follow-up turn fires no beforeSubmitPrompt) and `tool`
//   (postToolUse) → working.
// - `stop` → `completed` = done; `aborted` (Esc) = idle, like Claude
//   Code's and Codex's cancel; `error` = error, except the `error` stop
//   Cursor fires right after an `aborted` one for the same generation.

import type {
  HookPresenceEvent,
  HookPresenceReport,
  TurnBoundaryKind,
} from "../contracts/commands.js";
import {
  HOOK_PRESENCE_STARTING,
  type ProgramStatusReading,
} from "../contracts/harness.js";
import type { PresenceRecord } from "../contracts/model.js";

/** The message an `error` stop carries. */
export const HOOK_STOP_ERROR_MESSAGE = "The agent's turn ended with an error";

/** Whether an attachment is still starting (registered at spawn, no hook yet). */
export function hookPresenceStarting(
  status: PresenceRecord["status"] | undefined,
): boolean {
  return (
    !status ||
    (status.state === "working" && status.message === HOOK_PRESENCE_STARTING)
  );
}

/** The turn boundary a hook event is (none for `start`). */
export function hookPresenceBoundary(
  event: HookPresenceEvent,
): TurnBoundaryKind | undefined {
  return event === "start" ? undefined : event;
}

/**
 * The reading a hook report sets, or `undefined` when it changes nothing.
 * `abortedGeneration`: the generation of the last `aborted` stop.
 */
export function hookPresenceReading(
  current: PresenceRecord["status"] | undefined,
  report: Pick<HookPresenceReport, "event" | "status" | "generation">,
  abortedGeneration?: string,
): ProgramStatusReading | undefined {
  switch (report.event) {
    case "start":
      return hookPresenceStarting(current) ? { state: "idle" } : undefined;
    case "prompt":
    case "tool":
      return { state: "working" };
    case "stop":
      if (report.status === "aborted") return { state: "idle" };
      if (report.status === "error") {
        if (report.generation && report.generation === abortedGeneration) {
          return undefined;
        }
        return { state: "error", message: HOOK_STOP_ERROR_MESSAGE };
      }
      return { state: "done" };
  }
}
