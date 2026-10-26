// Pure logic behind the `harbormaster_find_tasks` / `harbormaster_send_to_task`
// agent tools (see /docs/task-messaging.md "Extension"): result formatting,
// sender derivation and attachment-path resolution. Kept free of the `pi`
// extension API and of `@harbormaster/core` I/O so it is testable with plain
// values; `index.ts` is the only place that wires it to `pi.registerTool` and
// `core.commands.findTasks` / `sendTaskMessage`.

import { isAbsolute, resolve } from "node:path";
import type { MessageSender, TaskSearchResult } from "@harbormaster/core";
import { TASK_STATE_LABELS } from "./task-widget.js";

/** Human label for a find result's run state (matches `harbormaster_subtask_status`'s wording). */
const RUN_LABELS: Record<TaskSearchResult["run"], string> = {
  working: "working",
  "your-move": "your move",
  queued: "queued",
  "not-running": "not running",
};

/** One match: `"<title>" (<id>) · <column> · <run state> · <relation>[ · <repo>[@<branch>]][ · PR #n]`. */
export function formatTaskSearchLine(result: TaskSearchResult): string {
  const parts: string[] = [
    `"${result.title}" (${result.id})`,
    TASK_STATE_LABELS[result.state],
    RUN_LABELS[result.run],
    result.relation === "none" ? "unrelated" : result.relation,
  ];
  if (result.repositoryId) {
    parts.push(
      result.branch
        ? `${result.repositoryId}@${result.branch}`
        : result.repositoryId,
    );
  } else if (result.branch) {
    parts.push(result.branch);
  }
  if (result.prNumber !== undefined) parts.push(`PR #${result.prNumber}`);
  return parts.join(" · ");
}

/** Plain readable text for every match, one per line; a hint when there are none. */
export function formatTaskSearchText(
  results: readonly TaskSearchResult[],
  query: string,
): string {
  if (!results.length) {
    return `No tasks match "${query}". Try fewer or different words, or set includeDone to also search finished tasks.`;
  }
  return results.map(formatTaskSearchLine).join("\n");
}

/** What `deriveMessageSender` needs from the running session (all resolved at execution time). */
export interface SenderContext {
  /** True only in the pane's own task session (never a nested/subagent one). */
  sessionIsTask: boolean;
  taskId: string | undefined;
  cwd: string;
  sessionId?: string;
}

/**
 * The sender core records for a send: this task, but only in the pane's own
 * task session; any other session (a plain Pi session, or a nested subagent
 * inheriting the task env) is a non-task `session` sender, which core always
 * routes through user approval. Never derived from tool arguments.
 */
export function deriveMessageSender(context: SenderContext): MessageSender {
  if (context.sessionIsTask && context.taskId) {
    return { kind: "task", taskId: context.taskId };
  }
  return {
    kind: "session",
    cwd: context.cwd,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  };
}

/** Resolves relative attachment paths against `cwd` (core copies from absolute paths only). */
export function resolveAttachmentPaths(
  paths: readonly string[] | undefined,
  cwd: string,
): string[] | undefined {
  if (!paths?.length) return undefined;
  return paths.map((path) => (isAbsolute(path) ? path : resolve(cwd, path)));
}
