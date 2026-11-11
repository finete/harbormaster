// The rules audit on a task (docs/release-plan.md "Audit log"): the
// workspace header shows the task's last rule action ("moved to Dev 4m ago
// because … matched rule … (rules.yaml:12)") and a History popover with
// its last 20 audit entries, read through `listEvents({ taskId })`.
// Re-read whenever the task record changes (a rule move changes it).
import { History } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AuditEntry } from "../../../preload/api";
import {
  describeAuditAction,
  historyLines,
  lastRuleAction,
} from "../lib/audit-lines";
import { useNow } from "../lib/use-now";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const HISTORY_LIMIT = 20;

export function TaskAudit({
  taskId,
  revision,
}: {
  taskId: string;
  /** Changes whenever the task record does (its `updatedAt`): re-read then. */
  revision: string;
}): JSX.Element | null {
  const now = useNow();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `open` are re-read triggers.
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core
      .listEvents({ taskId, limit: HISTORY_LIMIT })
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId, revision, open]);

  if (entries.length === 0) return null;
  const last = lastRuleAction(entries);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {last && (
        <span
          className="min-w-0 truncate text-[11px] text-muted-foreground"
          data-testid="task-audit-last"
          title={describeAuditAction(last, now)}
        >
          {describeAuditAction(last, now)}
        </span>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
            data-testid="task-audit-history-button"
            title="Rule history for this task"
          >
            <History className="h-3 w-3" />
            History
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[460px] p-2"
          data-testid="task-audit-history"
        >
          <h4 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Rule history (last {HISTORY_LIMIT})
          </h4>
          <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {historyLines(entries, now, HISTORY_LIMIT).map((line) => (
              <li
                key={line.key}
                data-kind={line.kind}
                className="rounded px-1 py-0.5 text-xs"
                title={line.at}
              >
                <span
                  className={
                    line.kind === "action"
                      ? "text-foreground"
                      : line.kind === "warning"
                        ? "text-amber-300"
                        : "text-muted-foreground"
                  }
                >
                  {line.text}
                </span>
              </li>
            ))}
          </ol>
        </PopoverContent>
      </Popover>
    </div>
  );
}
