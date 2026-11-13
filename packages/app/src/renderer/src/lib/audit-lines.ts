// Pure wording for the rules audit log on a task (docs/release-plan.md
// "Audit log": shown on the task). The workspace header shows the last
// rule action ("Review → Dev · 2h ago [Needs changes]"); its History
// popover lists recent rule actions (raw events on request). The
// technical "why" (event type, rule id, file:line) stays available as a
// secondary line / tooltip. Free of React (tests/audit-lines.test.ts).
import type { AuditActionEntry, AuditEntry } from "../../../preload/api";
import { relativeTime } from "./time-format";

const STATE: Record<string, string> = {
  backlog: "Backlog",
  dev: "Dev",
  done: "Done",
  await: "Awaiting",
  awaiting: "Awaiting",
};

const AWAITING_KIND: Record<string, string> = {
  review: "Review",
  deploy: "Deploy",
  slack: "Slack",
  "author-response": "Author response",
};

/** A column name; an awaiting column reads as its kind ("Review"). */
function columnName(state: string, awaitingKind?: string): string {
  if ((state === "await" || state === "awaiting") && awaitingKind) {
    return AWAITING_KIND[awaitingKind] ?? humanize(awaitingKind);
  }
  return STATE[state] ?? (state || "?");
}

function moveTarget(entry: AuditActionEntry): string {
  const to = typeof entry.with?.to === "string" ? entry.with.to : "";
  const kind =
    typeof entry.with?.kind === "string"
      ? entry.with.kind
      : to === "await"
        ? "review"
        : undefined;
  return columnName(to, kind);
}

/** "review-changes-requested" → "Review changes requested". */
export function humanize(id: string): string {
  const words = id.replace(/[-_.]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : id;
}

/** The rule's tag: its `label`, else its id humanized. */
export function auditRuleLabel(entry: AuditActionEntry): string {
  return entry.ruleLabel ?? humanize(entry.ruleId);
}

/** What the action did: "Review → Dev", "Moved to Dev", "Added inbox item". */
export function auditActionVerb(entry: AuditActionEntry): string {
  const detail = entry.detail ? ` (${entry.detail})` : "";
  if (entry.action === "move") {
    const target = moveTarget(entry);
    switch (entry.outcome) {
      case "applied":
        return entry.from
          ? `${columnName(entry.from.state, entry.from.awaitingKind)} → ${target}`
          : `Moved to ${target}`;
      case "stayed":
        return `Tried ${target}, stayed${detail}`;
      case "superseded":
        return `Would move to ${target} (an earlier rule won)`;
      case "skipped":
        return `Skipped move to ${target}${detail}`;
      case "failed":
        return `Failed to move to ${target}${detail}`;
    }
  }
  const what =
    entry.action === "inbox"
      ? "Added an inbox item"
      : entry.action === "createTask"
        ? "Created a task"
        : entry.action === "message"
          ? "Sent a message"
          : `Ran ${entry.action}`;
  return entry.outcome === "applied"
    ? what
    : `${humanize(entry.outcome)}: ${what[0]?.toLowerCase()}${what.slice(1)}${detail}`;
}

/** "2h ago" / "just now". */
export function auditAge(at: string, now: number): string {
  const age = relativeTime(at, now);
  return age === "now" ? "just now" : `${age} ago`;
}

/** The technical why: "github.pr.reviewDecisionChanged · rule review-changes-requested (rules.yaml:12)". */
export function auditActionWhy(entry: AuditActionEntry): string {
  return `${entry.eventType} · rule ${entry.ruleId} (${entry.file}:${entry.line})`;
}

/** One-line plain text (tooltips, copy): "Review → Dev · 4m ago · Needs changes". */
export function describeAuditAction(
  entry: AuditActionEntry,
  now: number,
): string {
  return `${auditActionVerb(entry)} · ${auditAge(entry.at, now)} · ${auditRuleLabel(entry)}`;
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

export interface HistoryLine {
  key: string;
  at: string;
  kind: AuditEntry["kind"];
  /** Main text: the move/action, the event type, or the warning. */
  text: string;
  /** Rule tag (actions only). */
  label?: string;
  /** Muted second line: the technical why (actions, rule warnings). */
  why?: string;
  /** "4m ago". */
  when: string;
}

/**
 * History rows, newest first. Raw events are noise next to the actions
 * they caused, so they are left out unless `includeEvents`; `limit`
 * applies after that filter.
 */
export function historyLines(
  entries: readonly AuditEntry[],
  now: number,
  { limit = 20, includeEvents = false } = {},
): HistoryLine[] {
  const shown = entries.filter(
    (entry) => includeEvents || entry.kind !== "event",
  );
  return shown
    .slice(Math.max(0, shown.length - limit))
    .reverse()
    .map((entry, index): HistoryLine => {
      const base = {
        key: `${entry.at}-${index}`,
        at: entry.at,
        kind: entry.kind,
        when: auditAge(entry.at, now),
      };
      if (entry.kind === "action") {
        return {
          ...base,
          text: auditActionVerb(entry),
          label: auditRuleLabel(entry),
          why: auditActionWhy(entry),
        };
      }
      if (entry.kind === "event") return { ...base, text: entry.event.type };
      return {
        ...base,
        text: `Warning: ${entry.message}`,
        ...(entry.ruleId
          ? {
              why: `rule ${entry.ruleId}${entry.file ? ` (${entry.file}:${entry.line ?? "?"})` : ""}`,
            }
          : {}),
      };
    });
}
