// The Costs page (docs/costs.md decision 7c): a top-level view like Rules /
// Inbox (sidebar Costs row; Esc goes back). "What did this task cost me?":
// a range / repository / agent / model filter row, a totals line and the
// tasks ranked by tokens, with a group-by strip that aggregates the same
// rows client-side. `$` only where the agent recorded an estimate, always
// labelled. Data: `listTaskUsage` (archived tasks included, the range is a
// filter, not retention), re-read on every board push. Export CSV hands
// the table's rows to main, which asks where to save them.
import { ChevronDown, Download, Gauge } from "lucide-react";
import type { JSX } from "react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { TaskUsageRow } from "../../../preload/api";
import { isTypingTarget } from "../lib/keyboard-guard";
import {
  filterUsageRows,
  formatCost,
  formatTokenCount,
  groupUsageRows,
  rowTokens,
  sortUsageRows,
  totalTokens,
  USAGE_RANGES,
  type UsageFilter,
  type UsageGroupBy,
  type UsageRange,
  type UsageSort,
  unavailableReason,
  usageCsvFileName,
  usageFilterOptions,
  usageRangeBounds,
  usageRowsToCsv,
  usageTotals,
} from "../lib/usage";
import { cn } from "../lib/utils";
import { describeThrown, pushToast } from "../toast";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Segmented } from "./ui/segmented";

/** Board pushes come in bursts (an agent streaming); re-read once they settle. */
const REQUERY_DEBOUNCE_MS = 400;

const GROUP_BY_OPTIONS: ReadonlyArray<{ value: UsageGroupBy; label: string }> =
  [
    { value: "task", label: "Task" },
    { value: "repo", label: "Repo" },
    { value: "harness", label: "Harness" },
    { value: "model", label: "Model" },
  ];

const ALL = "__all__";

export function CostsView({
  active,
  onOpenTask,
  onBack,
}: {
  /** The page is showing and no dialog is up: Esc is live. */
  active: boolean;
  /** Same action as clicking the task's board card. */
  onOpenTask: (taskId: string) => void;
  /** Esc: back to the previous view. */
  onBack: () => void;
}): JSX.Element {
  const [range, setRange] = useState<UsageRange>("week");
  const [filter, setFilter] = useState<UsageFilter>({});
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("task");
  const [sort, setSort] = useState<UsageSort>("tokens");
  const [rows, setRows] = useState<TaskUsageRow[] | null>(null);
  const [exporting, setExporting] = useState(false);

  // The range is resolved against "now" at each read, so a page left open
  // across midnight still means "this week" on the next push.
  const load = useCallback(() => {
    return window.harbormaster.core
      .listTaskUsage({
        includeArchived: true,
        ...usageRangeBounds(range, new Date()),
      })
      .then(setRows)
      .catch((error: unknown) => {
        setRows([]);
        pushToast(`Could not read usage: ${describeThrown(error)}`);
      });
  }, [range]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.harbormaster.core.onBoardChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), REQUERY_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented) return;
      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }
      if (isTypingTarget(event.target)) {
        (event.target as HTMLElement).blur();
        return;
      }
      event.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onBack]);

  const options = useMemo(() => usageFilterOptions(rows ?? []), [rows]);
  const shown = useMemo(
    () => sortUsageRows(filterUsageRows(rows ?? [], filter), sort),
    [rows, filter, sort],
  );
  const totals = usageTotals(shown);
  const groups = useMemo(
    () => (groupBy === "task" ? [] : groupUsageRows(shown, groupBy)),
    [shown, groupBy],
  );

  function exportCsv(): void {
    setExporting(true);
    void window.harbormaster.app
      .saveTextFile(usageCsvFileName(new Date()), usageRowsToCsv(shown))
      .then((path) => {
        if (path) pushToast(`Saved ${path}`, "success");
      })
      .catch((error: unknown) =>
        pushToast(`Could not export usage: ${describeThrown(error)}`),
      )
      .finally(() => setExporting(false));
  }

  return (
    <div
      data-testid="costs-view"
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Gauge className="h-4 w-4 text-foreground" aria-hidden />
        <span className="text-sm font-medium" data-testid="costs-title">
          Costs
        </span>
        <span className="text-xs text-muted-foreground">
          est. at list price · not your bill
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-testid="costs-export-csv"
            disabled={exporting || shown.length === 0}
            onClick={exportCsv}
            title="Save these rows as a CSV file"
          >
            <Download aria-hidden />
            Export CSV
          </Button>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <FilterChip
          label="Range"
          testId="costs-filter-range"
          value={range}
          options={USAGE_RANGES.map((entry) => ({
            value: entry.value,
            label: entry.label,
          }))}
          onChange={(value) => setRange(value as UsageRange)}
        />
        <FilterChip
          label="Repo"
          testId="costs-filter-repo"
          value={filter.repository ?? ALL}
          options={withAll(options.repositories)}
          onChange={(value) =>
            setFilter((current) => ({
              ...current,
              repository: value === ALL ? undefined : value,
            }))
          }
        />
        <FilterChip
          label="Harness"
          testId="costs-filter-harness"
          value={filter.harness ?? ALL}
          options={withAll(options.harnesses)}
          onChange={(value) =>
            setFilter((current) => ({
              ...current,
              harness: value === ALL ? undefined : value,
            }))
          }
        />
        <FilterChip
          label="Model"
          testId="costs-filter-model"
          value={filter.model ?? ALL}
          options={withAll(options.models)}
          onChange={(value) =>
            setFilter((current) => ({
              ...current,
              model: value === ALL ? undefined : value,
            }))
          }
        />
        <Segmented
          ariaLabel="Group by"
          size="sm"
          className="ml-auto"
          testId="costs-group-by"
          value={groupBy}
          onValueChange={setGroupBy}
          options={GROUP_BY_OPTIONS.map((option) => ({
            ...option,
            testId: `costs-group-${option.value}`,
          }))}
        />
      </div>
      <div
        className="shrink-0 px-3 py-2 font-mono text-xs text-muted-foreground"
        data-testid="costs-totals"
      >
        {totals.tasks} {totals.tasks === 1 ? "task" : "tasks"} ·{" "}
        {formatTokenCount(totals.tokens)} tokens
        {totals.cost !== undefined ? ` · ${formatCost(totals.cost)} est.` : ""}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {rows === null ? null : shown.length === 0 ? (
          <p
            className="py-6 text-center text-xs text-muted-foreground"
            data-testid="costs-empty"
          >
            No task usage in this range.
          </p>
        ) : groupBy === "task" ? (
          <table className="w-full text-xs" data-testid="costs-table">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3 font-semibold">Task</th>
                <th className="py-1.5 pr-3 font-semibold">Repo</th>
                <th className="py-1.5 pr-3 font-semibold">Harness</th>
                <th className="py-1.5 pr-3 font-semibold">Models</th>
                <SortHeader
                  label="Tokens"
                  active={sort === "tokens"}
                  onClick={() => setSort("tokens")}
                  testId="costs-sort-tokens"
                />
                <SortHeader
                  label="Est. $"
                  active={sort === "cost"}
                  onClick={() => setSort("cost")}
                  testId="costs-sort-cost"
                />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <CostsRow key={row.taskId} row={row} onOpenTask={onOpenTask} />
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-xs" data-testid="costs-groups">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3 font-semibold">
                  {GROUP_BY_OPTIONS.find((option) => option.value === groupBy)
                    ?.label ?? ""}
                </th>
                <th className="py-1.5 pr-3 text-right font-semibold">Tasks</th>
                <th className="py-1.5 pr-3 text-right font-semibold">Turns</th>
                <th className="py-1.5 pr-3 text-right font-semibold">Tokens</th>
                <th className="py-1.5 text-right font-semibold">Est. $</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr
                  key={group.key}
                  data-testid="costs-group-row"
                  data-key={group.key}
                  className="border-b border-border/60"
                >
                  <td className="max-w-0 truncate py-1.5 pr-3 font-mono text-foreground">
                    {group.key}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">
                    {group.tasks}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">
                    {group.turns}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-foreground">
                    {formatTokenCount(group.tokens)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-muted-foreground">
                    {group.cost !== undefined ? formatCost(group.cost) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function withAll(
  values: readonly string[],
): Array<{ value: string; label: string }> {
  return [
    { value: ALL, label: "All" },
    ...values.map((value) => ({ value, label: value })),
  ];
}

function FilterChip({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  testId: string;
}): JSX.Element {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip
          label={label}
          value={current?.label ?? value}
          valueTestId={`${testId}-value`}
          data-testid={testId}
        >
          <ChevronDown aria-hidden />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <Fragment key={option.value}>
              <DropdownMenuRadioItem
                value={option.value}
                data-testid={`${testId}-option`}
              >
                {option.label}
              </DropdownMenuRadioItem>
              {option.value === ALL && options.length > 1 && (
                <DropdownMenuSeparator />
              )}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortHeader({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}): JSX.Element {
  return (
    <th
      className="py-1.5 pr-3 text-right font-semibold last:pr-0"
      aria-sort={active ? "descending" : "none"}
    >
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active && <ChevronDown className="h-3 w-3" aria-hidden />}
      </button>
    </th>
  );
}

function CostsRow({
  row,
  onOpenTask,
}: {
  row: TaskUsageRow;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const usage = row.usage;
  const tokens = rowTokens(row);
  const tokenCell =
    usage.status === "ready" ? (
      row.subtaskUsage ? (
        <span
          title={`Own ${tokens.toLocaleString()} · incl. ${row.subtaskUsage.count} ${row.subtaskUsage.count === 1 ? "subtask" : "subtasks"}`}
        >
          {formatTokenCount(tokens)}
          <span className="text-muted-foreground">
            {" · incl. "}
            {formatTokenCount(tokens + totalTokens(row.subtaskUsage))}
          </span>
        </span>
      ) : (
        formatTokenCount(tokens)
      )
    ) : usage.status === "pending" ? (
      <span className="text-muted-foreground" title="Usage is being counted">
        …
      </span>
    ) : (
      <span className="text-muted-foreground" title={unavailableReason(usage)}>
        n/a
      </span>
    );
  return (
    <tr
      data-testid="costs-row"
      data-task-id={row.taskId}
      tabIndex={0}
      onClick={() => onOpenTask(row.taskId)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpenTask(row.taskId);
      }}
      className="cursor-pointer border-b border-border/60 outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <td
        className="max-w-0 truncate py-1.5 pr-3 text-foreground"
        title={row.title}
      >
        {row.title}
      </td>
      <td
        className="max-w-0 truncate py-1.5 pr-3 font-mono text-muted-foreground"
        title={row.repository}
      >
        {row.repository || "—"}
      </td>
      <td className="py-1.5 pr-3 font-mono text-muted-foreground">
        {row.harness}
      </td>
      <td
        className="max-w-0 truncate py-1.5 pr-3 font-mono text-muted-foreground"
        title={usage.byModel.map((model) => model.model).join(", ")}
      >
        {usage.byModel.map((model) => model.model).join(", ") || "—"}
      </td>
      <td
        className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-foreground"
        data-testid="costs-row-tokens"
      >
        {tokenCell}
      </td>
      <td
        className="whitespace-nowrap py-1.5 text-right font-mono text-muted-foreground"
        data-testid="costs-row-cost"
      >
        {usage.cost !== undefined ? formatCost(usage.cost) : "—"}
      </td>
    </tr>
  );
}
