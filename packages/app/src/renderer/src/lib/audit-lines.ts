// Pure wording for the rules audit log on a task (docs/release-plan.md
// "Audit log": shown on the task, "moved to Dev because …"). The workspace
// header shows the last rule action; its History popover lists the last
// 20 entries. Free of React (tests/audit-lines.test.ts).
import type { AuditActionEntry, AuditEntry } from "../../../preload/api";
import { relativeTime } from "./time-format";

const COLUMN: Record<string, string> = {
  dev: "Dev",
  done: "Done",
  await: "Awaiting",
};

function moveTarget(entry: AuditActionEntry): string {
  const to = typeof entry.with?.to === "string" ? entry.with.to : "";
  const column = COLUMN[to] ?? (to || "?");
  const kind = typeof entry.with?.kind === "string" ? entry.with.kind : "";
  return to === "await" && kind ? `${column}: ${kind}` : column;
}

/** What the action did, without the "because" part. */
export function auditActionVerb(entry: AuditActionEntry): string {
  const detail = entry.detail ? ` (${entry.detail})` : "";
  if (entry.action === "move") {
    const target = moveTarget(entry);
    switch (entry.outcome) {
      case "applied":
        return `moved to ${target}`;
      case "stayed":
        return `tried to move to ${target}, stayed${detail}`;
      case "superseded":
        return `would have moved to ${target} (an earlier rule won)`;
      case "skipped":
        return `did not move to ${target}${detail}`;
      case "failed":
        return `failed to move to ${target}${detail}`;
    }
  }
  const what =
    entry.action === "inbox"
      ? "added an inbox item"
      : entry.action === "createTask"
        ? "created a task"
        : entry.action === "message"
          ? "sent a message"
          : `ran ${entry.action}`;
  return entry.outcome === "applied"
    ? what
    : `${entry.outcome}: ${what}${detail}`;
}

/** "moved to Dev 4m ago because github.pr.reviewDecisionChanged matched rule review-changes-requested (rules.yaml:12)" */
export function describeAuditAction(
  entry: AuditActionEntry,
  now: number,
): string {
  const age = relativeTime(entry.at, now);
  const when = age === "now" ? "just now" : `${age} ago`;
  return `${auditActionVerb(entry)} ${when} because ${entry.eventType} matched rule ${entry.ruleId} (${entry.file}:${entry.line})`;
}

/** The newest rule action in an oldest-first audit list. */
export function lastRuleAction(
  entries: readonly AuditEntry[],
): AuditActionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind === "action") return entry;
  }
  return undefined;
}

/** One History row: newest first, each with its own wording. */
export function historyLines(
  entries: readonly AuditEntry[],
  now: number,
  limit = 20,
): Array<{ key: string; at: string; kind: AuditEntry["kind"]; text: string }> {
  return entries
    .slice(Math.max(0, entries.length - limit))
    .reverse()
    .map((entry, index) => ({
      key: `${entry.at}-${index}`,
      at: entry.at,
      kind: entry.kind,
      text:
        entry.kind === "action"
          ? describeAuditAction(entry, now)
          : entry.kind === "event"
            ? `${entry.event.type} (${relativeTime(entry.at, now)} ago)`
            : `warning${entry.ruleId ? ` in rule ${entry.ruleId}` : ""}: ${entry.message}`,
    }));
}
