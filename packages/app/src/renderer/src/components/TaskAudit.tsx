// The rules audit on a task (docs/release-plan.md "Audit log"): the
// workspace header shows the task's last rule action ("Review → Dev ·
// 4m ago [Needs changes]", the event/rule/file:line in its tooltip) and a
// History popover with recent rule actions (raw events on request), read
// through `listEvents({ taskId })`. Re-read whenever the task record
// changes (a rule move changes it). The component fills the space it is
// given so History stays pinned to its right edge whether or not there is
// a last action to show.
import { History } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AuditEntry } from "../../../preload/api";
import {
  auditActionVerb,
  auditActionWhy,
  auditAge,
  auditRuleLabel,
  historyLines,
  lastRuleAction,
} from "../lib/audit-lines";
import { useNow } from "../lib/use-now";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const HISTORY_LIMIT = 20;
/** Raw events outnumber actions; read enough to still find 20 actions. */
const READ_LIMIT = 300;

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
  const [showEvents, setShowEvents] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `open` are re-read triggers.
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core
      .listEvents({ taskId, limit: READ_LIMIT })
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
  const lines = historyLines(entries, now, {
    limit: HISTORY_LIMIT,
    includeEvents: showEvents,
  });
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {last ? (
        <div
          className="flex min-w-0 flex-1 items-center gap-2 text-xs"
          data-testid="task-audit-last"
          title={`${auditActionVerb(last)} ${auditAge(last.at, now)}\n${auditActionWhy(last)}`}
        >
          <span className="shrink-0 font-medium text-foreground">
            {auditActionVerb(last)}
          </span>
          <span className="shrink-0 text-muted-foreground">
            · {auditAge(last.at, now)}
          </span>
          <Badge
            variant="neutral"
            className="min-w-0 truncate px-1.5 py-0 text-[11px]"
          >
            {auditRuleLabel(last)}
          </Badge>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2"
            data-testid="task-audit-history-button"
            title="Rule history for this task"
          >
            <History className="h-3.5 w-3.5" />
            History
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[460px] p-2"
          data-testid="task-audit-history"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Rule history
            </h4>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              aria-pressed={showEvents}
              data-testid="task-audit-show-events"
              onClick={() => setShowEvents((value) => !value)}
            >
              {showEvents ? "Hide events" : "Show events"}
            </Button>
          </div>
          {lines.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No rule actions yet.
            </p>
          ) : (
            <ol className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
              {lines.map((line) => (
                <li
                  key={line.key}
                  data-kind={line.kind}
                  className={cn(
                    "rounded px-1",
                    line.kind === "event" ? "py-0" : "py-1",
                  )}
                  title={line.at}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        line.kind === "action" &&
                          "text-xs font-medium text-foreground",
                        line.kind === "warning" &&
                          "text-xs text-status-needsYou",
                        line.kind === "event" &&
                          "font-mono text-[11px] text-muted-foreground",
                      )}
                    >
                      {line.text}
                    </span>
                    {line.label && (
                      <Badge
                        variant="neutral"
                        className="shrink-0 px-1.5 py-0 text-[11px]"
                      >
                        {line.label}
                      </Badge>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {line.when}
                    </span>
                  </div>
                  {line.why && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {line.why}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
