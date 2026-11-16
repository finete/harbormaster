// The task workspace's usage chip (docs/costs.md decision 7a): "◔ 9.8M tok ·
// ~$23.10" next to the audit trail, click → a popover with the token
// buckets, the labelled cost estimate, the per-model table, the sessions
// counted and the subtask roll-up. Reads `task.usage` (live via the board
// push); the refresh button recomputes it through `refreshTaskUsage`.
import { RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { Task, TaskUsage } from "../../../preload/api";
import { flattenBoard, useBoard } from "../core-client";
import {
  costLabel,
  formatCost,
  formatTokenCount,
  shortSessionId,
  subtaskRollup,
  totalTokens,
  unavailableReason,
  usageSummary,
} from "../lib/usage";
import { cn } from "../lib/utils";
import { describeThrown, pushToast } from "../toast";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function TaskUsageChip({ task }: { task: Task }): JSX.Element | null {
  const usage = task.usage;
  const columns = useBoard();
  const [open, setOpen] = useState(false);
  const subtasks = useMemo(
    () =>
      subtaskRollup(
        flattenBoard(columns).map((row) => row.task),
        task.id,
      ),
    [columns, task.id],
  );
  if (!usage) return null;
  const title =
    usage.status === "unavailable"
      ? unavailableReason(usage)
      : usage.status === "pending"
        ? "Usage is being counted"
        : "Token usage for this task";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="task-usage-chip"
          data-status={usage.status}
          title={title}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 font-mono text-[11px] text-muted-foreground outline-none transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <span aria-hidden>◔</span>
          {usageSummary(usage)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[420px] p-3"
        data-testid="task-usage-popover"
      >
        <UsageDetails taskId={task.id} usage={usage} subtasks={subtasks} />
      </PopoverContent>
    </Popover>
  );
}

function UsageDetails({
  taskId,
  usage,
  subtasks,
}: {
  taskId: string;
  usage: TaskUsage;
  subtasks: ReturnType<typeof subtaskRollup>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  function refresh(): void {
    setBusy(true);
    void window.harbormaster.core
      .refreshTaskUsage(taskId)
      .catch((error: unknown) =>
        pushToast(`Could not recount usage: ${describeThrown(error)}`),
      )
      .finally(() => setBusy(false));
  }
  const ready = usage.status === "ready";
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Usage
        </h4>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          aria-label="Recount usage"
          title="Recount this task's usage from its session files"
          data-testid="task-usage-refresh"
          disabled={busy}
          aria-busy={busy}
          onClick={refresh}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
        </Button>
      </div>
      {!ready ? (
        <p className="text-muted-foreground" data-testid="task-usage-status">
          {usage.status === "pending"
            ? "Counting usage…"
            : unavailableReason(usage)}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-0.5" data-testid="task-usage-total">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-foreground">Tokens</span>
              <span className="font-mono font-medium text-foreground">
                {formatTokenCount(totalTokens(usage.totals))}
              </span>
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {formatTokenCount(usage.totals.input)} input ·{" "}
              {formatTokenCount(usage.totals.output)} output ·{" "}
              {formatTokenCount(usage.totals.cacheRead)} cache read ·{" "}
              {formatTokenCount(usage.totals.cacheWrite)} cache write
            </div>
          </div>
          {usage.cost !== undefined && (
            <div
              className="flex flex-col gap-0.5"
              data-testid="task-usage-cost"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-foreground">Est. cost</span>
                <span className="font-mono font-medium text-foreground">
                  {formatCost(usage.cost)}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {costLabel(usage.costSource)}
              </div>
            </div>
          )}
          {usage.byModel.length > 0 && (
            <section className="flex flex-col gap-1">
              <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                By model
              </h5>
              <table
                className="w-full font-mono text-[11px]"
                data-testid="task-usage-models"
              >
                <tbody>
                  {usage.byModel.map((model) => (
                    <tr key={model.model} className="text-muted-foreground">
                      <td className="max-w-0 truncate py-0.5 pr-2 text-foreground">
                        {model.model}
                      </td>
                      <td className="whitespace-nowrap py-0.5 pr-2 text-right">
                        {formatTokenCount(totalTokens(model))}
                      </td>
                      <td className="whitespace-nowrap py-0.5 pr-2 text-right">
                        {model.cost !== undefined ? formatCost(model.cost) : ""}
                      </td>
                      <td className="whitespace-nowrap py-0.5 text-right">
                        {model.turns} {model.turns === 1 ? "turn" : "turns"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {usage.sessions.length > 0 && (
            <section className="flex flex-col gap-1">
              <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Sessions
              </h5>
              <ul
                className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground"
                data-testid="task-usage-sessions"
              >
                {usage.sessions.map((session) => (
                  <li
                    key={session.sessionPath}
                    className="flex items-baseline gap-2"
                    title={session.sessionPath}
                  >
                    <span className="text-foreground">{session.harness}</span>
                    <span>{shortSessionId(session.sessionPath)}</span>
                    <span className="ml-auto">
                      {formatTokenCount(totalTokens(session.totals))}
                    </span>
                    {session.cost !== undefined && (
                      <span>{formatCost(session.cost)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {subtasks && (
        <div
          className="flex items-baseline justify-between gap-2 border-t border-border pt-2"
          data-testid="task-usage-subtasks"
        >
          <span className="text-foreground">
            Incl. {subtasks.count}{" "}
            {subtasks.count === 1 ? "subtask" : "subtasks"}
          </span>
          <span className="font-mono text-muted-foreground">
            {formatTokenCount(totalTokens(subtasks))} tok
            {subtasks.cost !== undefined
              ? ` · ${formatCost(subtasks.cost)}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}
