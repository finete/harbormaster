// Engine: what each rule last did, folded from the rules audit log for the
// Rules page (docs/rules-page.md decision 13). Pure: the manager reads the
// window from AuditLogAccess and hands the entries in.

import type { AuditEntry, RuleActivity } from "../../contracts/rules.js";

/** Days of audit log the Rules page summarizes. */
export const RULE_ACTIVITY_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of the activity window ending at `now`, as an ISO time. */
export function ruleActivitySince(now: Date, windowDays: number): string {
  return new Date(now.getTime() - windowDays * DAY_MS).toISOString();
}

/** Map key of a rule's activity: rules-dir-relative file + rule id. */
export function ruleActivityKey(file: string, ruleId: string): string {
  return `${file}\u0000${ruleId}`;
}

/**
 * Per `(file, ruleId)` (see `ruleActivityKey`): the latest audited action's
 * time, outcome, detail and task, plus how many actions the rule had in the
 * window `[now - windowDays, now]`. Events and warnings are ignored; entries
 * outside the window (or with an unparsable time) do not count. Ties on
 * time go to the later entry in log order.
 */
export function foldRuleActivity(
  entries: readonly AuditEntry[],
  now: Date,
  windowDays: number,
): Map<string, RuleActivity> {
  const end = now.getTime();
  const start = end - windowDays * DAY_MS;
  const activity = new Map<string, RuleActivity>();
  for (const entry of entries) {
    if (entry.kind !== "action") continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const key = ruleActivityKey(entry.file, entry.ruleId);
    const previous = activity.get(key);
    const count = (previous?.count ?? 0) + 1;
    if (previous && Date.parse(previous.lastAt) > at) {
      previous.count = count;
      continue;
    }
    activity.set(key, {
      lastAt: entry.at,
      lastOutcome: entry.outcome,
      ...(entry.detail !== undefined ? { lastDetail: entry.detail } : {}),
      ...(entry.taskId !== undefined ? { lastTaskId: entry.taskId } : {}),
      count,
    });
  }
  return activity;
}
