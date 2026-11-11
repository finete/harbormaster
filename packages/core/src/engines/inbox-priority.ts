// Engine: the inbox's optional Priority / Other override
// (docs/release-plan.md "Inbox": "Optional CEL override in settings").
// `GlobalConfig.inbox.priorityFilter` is a CEL expression over `item`
// (`kind`, `source`, `taskId`, `repo`, `priority`); it must return a
// boolean. Absent, invalid, or non-boolean for an item = that item keeps
// its producer's default, so a typo never empties the Priority tab. Pure.

import type { InboxPriorityInput } from "../contracts/inbox.js";
import { evaluateCel } from "./rules/cel.js";

export interface InboxPriorityResult {
  /** One per input item, same order. */
  priorities: boolean[];
  /** The first evaluation problem, if any (shown once, never thrown). */
  warning?: string;
}

export function applyInboxPriorityFilter(
  items: readonly InboxPriorityInput[],
  filter: string | undefined,
): InboxPriorityResult {
  if (!filter?.trim()) {
    return { priorities: items.map((item) => item.priority) };
  }
  let warning: string | undefined;
  const priorities = items.map((item) => {
    try {
      const value = evaluateCel(filter, {
        item: {
          id: item.id,
          kind: item.kind,
          source: item.source ?? null,
          taskId: item.taskId ?? null,
          repo: item.repo ?? null,
          priority: item.priority,
        },
      });
      if (typeof value === "boolean") return value;
      warning ??= `inbox.priorityFilter must return a boolean, got ${value === null ? "null" : typeof value}`;
    } catch (error) {
      warning ??= `inbox.priorityFilter: ${error instanceof Error ? error.message : String(error)}`;
    }
    return item.priority;
  });
  return { priorities, ...(warning ? { warning } : {}) };
}
