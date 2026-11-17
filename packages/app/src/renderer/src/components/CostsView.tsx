// The Costs page (docs/costs.md decision 7c): a top-level view like Rules /
// Inbox (sidebar Costs row; Esc goes back). "What did this task cost me?":
// a range / repository / agent / model filter row, a totals line and the
// tasks ranked by tokens, with a group-by strip that aggregates the same
// rows client-side. `$` only where the agent recorded an estimate, always
// labelled. Data: `listTaskUsage` (archived tasks included, the range is a
// filter, not retention), re-read on every board push; rows the backfill
// has not counted yet (`pending`) are left out of the table and counted on
// the totals line ("counting N more…"). A parent's figures lead with the
// total including its subtasks (sorted on), own usage muted beside it. A
// search box narrows the rows before totals, group-by and CSV. Export CSV
// hands the table's rows to main, which asks where to save them. Columns
// are fixed-layout with user-resizable, persisted px widths
// (lib/costs-columns.ts): drag a header's right edge, double-click it to
// reset; the group-by table reuses the Task / Tokens / Est. $ widths.
import { ChevronDown, Download, Gauge, Search, X } from "lucide-react";
import type { JSX, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TaskUsageRow } from "../../../preload/api";
import {
  COSTS_GROUP_COLUMNS,
  COSTS_TABLE_COLUMNS,
  type ColumnWidths,
  type CostsColumnKey,
  clampColumnWidth,
  FALLBACK_CONTAINER_WIDTH,
  readColumnWidths,
  resetColumn,
  resolveColumnWidths,
  storeColumnWidths,
} from "../lib/costs-columns";
import { isTypingTarget } from "../lib/keyboard-guard";
import {
  costFigure,
  filterUsageRows,
  formatCost,
  formatTokenCount,
  groupUsageRows,
  isCountingRow,
  rowTokens,
  searchUsageRows,
  sortUsageRows,
  tokensFigure,
  USAGE_RANGES,
  USAGE_TOTALS_TITLE,
  type UsageFigure,
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
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const columns = useColumnWidths();

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

  // Not counted yet: off the table, counted on the totals line (the model
  // filter can't apply to them: their models are not known yet).
  const counted = useMemo(
    () => (rows ?? []).filter((row) => !isCountingRow(row)),
    [rows],
  );
  const counting = useMemo(
    () =>
      filterUsageRows((rows ?? []).filter(isCountingRow), {
        ...filter,
        model: undefined,
      }).length,
    [rows, filter],
  );
  const options = useMemo(() => usageFilterOptions(counted), [counted]);
  const filtered = useMemo(
    () => filterUsageRows(counted, filter),
    [counted, filter],
  );
  const shown = useMemo(
    () => sortUsageRows(searchUsageRows(filtered, search), sort),
    [filtered, search, sort],
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
          testId="costs-group-by"
          value={groupBy}
          onValueChange={setGroupBy}
          options={GROUP_BY_OPTIONS.map((option) => ({
            ...option,
            testId: `costs-group-${option.value}`,
          }))}
        />
        <div className="relative ml-auto w-56">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="text"
            data-testid="costs-search"
            aria-label="Filter tasks"
            placeholder="Filter tasks…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              // Esc here clears the filter (then leaves the box); it never
              // leaves the page (the page handler skips a handled Esc).
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (search) setSearch("");
              else event.currentTarget.blur();
            }}
            spellCheck={false}
            className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-7 text-[13px] text-foreground transition-colors duration-[120ms] ease-out placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {search && (
            <button
              type="button"
              data-testid="costs-search-clear"
              aria-label="Clear filter"
              title="Clear (Esc)"
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div
        className="shrink-0 px-3 py-2 font-mono text-xs text-muted-foreground"
        data-testid="costs-totals"
        title={USAGE_TOTALS_TITLE}
      >
        {totals.tasks} {totals.tasks === 1 ? "task" : "tasks"} ·{" "}
        {formatTokenCount(totals.tokens)} tokens
        {totals.cost !== undefined ? ` · ${formatCost(totals.cost)} est.` : ""}
        {counting > 0 && (
          <span data-testid="costs-counting">{` · counting ${counting} more…`}</span>
        )}
      </div>
      <div
        ref={columns.containerRef}
        className="min-h-0 flex-1 overflow-auto px-3 pb-3"
      >
        {rows === null ? null : shown.length === 0 &&
          search.trim() ? null : shown.length === 0 ? (
          <p
            className="py-6 text-center text-xs text-muted-foreground"
            data-testid="costs-empty"
          >
            No task usage in this range.
          </p>
        ) : groupBy === "task" ? (
          <ResizableTable
            testId="costs-table"
            columns={COSTS_TABLE_COLUMNS}
            labels={{
              task: "Task",
              repo: "Repo",
              harness: "Harness",
              models: "Models",
              tokens: (
                <SortButton
                  label="Tokens"
                  active={sort === "tokens"}
                  onClick={() => setSort("tokens")}
                  testId="costs-sort-tokens"
                />
              ),
              cost: (
                <SortButton
                  label="Est. $"
                  active={sort === "cost"}
                  onClick={() => setSort("cost")}
                  testId="costs-sort-cost"
                />
              ),
            }}
            sorted={{
              tokens: sort === "tokens",
              cost: sort === "cost",
            }}
            state={columns}
          >
            <tbody>
              {shown.map((row) => (
                <CostsRow key={row.taskId} row={row} onOpenTask={onOpenTask} />
              ))}
            </tbody>
          </ResizableTable>
        ) : (
          <ResizableTable
            testId="costs-groups"
            columns={COSTS_GROUP_COLUMNS}
            labels={{
              task:
                GROUP_BY_OPTIONS.find((option) => option.value === groupBy)
                  ?.label ?? "",
              groupTasks: "Tasks",
              groupTurns: "Turns",
              tokens: "Tokens",
              cost: "Est. $",
            }}
            state={columns}
          >
            <tbody>
              {groups.map((group) => (
                <tr
                  key={group.key}
                  data-testid="costs-group-row"
                  data-key={group.key}
                  className="border-b border-border/60"
                >
                  <td
                    className="truncate py-1.5 pr-3 font-mono text-foreground"
                    title={group.key}
                  >
                    {group.key}
                  </td>
                  <td className="truncate py-1.5 pr-3 text-right font-mono text-muted-foreground">
                    {group.tasks}
                  </td>
                  <td className="truncate py-1.5 pr-3 text-right font-mono text-muted-foreground">
                    {group.turns}
                  </td>
                  <td className="truncate py-1.5 pr-3 text-right font-mono text-foreground">
                    {formatTokenCount(group.tokens)}
                  </td>
                  <td className="truncate py-1.5 text-right font-mono text-muted-foreground">
                    {group.cost !== undefined ? formatCost(group.cost) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </ResizableTable>
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

/** A numeric header's sort toggle (the cell itself is a `ColumnHeader`). */
function SortButton({
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
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex max-w-full items-center gap-1 uppercase tracking-wide hover:text-foreground",
        active && "text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      {active && <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />}
    </button>
  );
}

/** Columns right-aligned (numbers), in both tables. */
const NUMERIC_COLUMNS: ReadonlySet<CostsColumnKey> = new Set([
  "tokens",
  "cost",
  "groupTasks",
  "groupTurns",
]);

interface ColumnWidthsState {
  /** The scroll container the default widths are shares of. */
  containerRef: (element: HTMLDivElement | null) => void;
  containerWidth: number;
  /** User-set widths (persisted); missing keys use their default. */
  widths: ColumnWidths;
  /** Live width while dragging (not persisted yet). */
  setWidth: (key: CostsColumnKey, width: number) => void;
  /** End of a drag: set and persist the final width. */
  commit: (key: CostsColumnKey, width: number) => void;
  /** Double-click: back to the default, persisted. */
  reset: (key: CostsColumnKey) => void;
}

/** Persisted column widths + the measured container width they resolve against. */
function useColumnWidths(): ColumnWidthsState {
  const [widths, setWidths] = useState<ColumnWidths>(() =>
    readColumnWidths(window.localStorage),
  );
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const [containerWidth, setContainerWidth] = useState(
    FALLBACK_CONTAINER_WIDTH,
  );
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!container) return;
    const measure = (): void => {
      const style = window.getComputedStyle(container);
      const inner =
        container.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      if (inner > 0) setContainerWidth(Math.floor(inner));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  const setWidth = useCallback((key: CostsColumnKey, width: number) => {
    setWidths((current) => ({ ...current, [key]: clampColumnWidth(width) }));
  }, []);
  const commit = useCallback((key: CostsColumnKey, width: number) => {
    const next = { ...widthsRef.current, [key]: clampColumnWidth(width) };
    widthsRef.current = next;
    setWidths(next);
    storeColumnWidths(window.localStorage, next);
  }, []);
  const reset = useCallback((key: CostsColumnKey) => {
    const next = resetColumn(widthsRef.current, key);
    widthsRef.current = next;
    setWidths(next);
    storeColumnWidths(window.localStorage, next);
  }, []);

  return {
    containerRef: setContainer,
    containerWidth,
    widths,
    setWidth,
    commit,
    reset,
  };
}

/**
 * A fixed-layout table whose header cells (all but the last) carry a resize
 * handle on their right edge. Wider than its container → the container
 * scrolls horizontally.
 */
function ResizableTable({
  testId,
  columns,
  labels,
  sorted,
  state,
  children,
}: {
  testId: string;
  columns: readonly CostsColumnKey[];
  labels: Partial<Record<CostsColumnKey, ReactNode>>;
  /** `aria-sort` for sortable headers. */
  sorted?: Partial<Record<CostsColumnKey, boolean>>;
  state: ColumnWidthsState;
  children: ReactNode;
}): JSX.Element {
  const resolved = resolveColumnWidths(
    columns,
    state.widths,
    state.containerWidth,
  );
  const total = resolved.reduce((sum, width) => sum + width, 0);
  return (
    <table
      className="table-fixed border-collapse text-xs"
      style={{ width: total }}
      data-testid={testId}
    >
      <colgroup>
        {columns.map((key, index) => (
          <col key={key} style={{ width: resolved[index] }} />
        ))}
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          {columns.map((key, index) => {
            const last = index === columns.length - 1;
            const sortable = sorted !== undefined && key in sorted;
            return (
              <th
                key={key}
                data-testid={`costs-th-${key}`}
                aria-sort={
                  sortable ? (sorted[key] ? "descending" : "none") : undefined
                }
                className={cn(
                  "relative py-1.5 font-semibold",
                  !last && "pr-3",
                  NUMERIC_COLUMNS.has(key) && "text-right",
                )}
              >
                <div className="truncate">{labels[key]}</div>
                {!last && (
                  <ColumnResizeHandle
                    column={key}
                    width={resolved[index] ?? 0}
                    onResize={state.setWidth}
                    onCommit={state.commit}
                    onReset={state.reset}
                  />
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      {children}
    </table>
  );
}

/** Drag (pointer-captured) to resize a column; double-click resets it. */
function ColumnResizeHandle({
  column,
  width,
  onResize,
  onCommit,
  onReset,
}: {
  column: CostsColumnKey;
  width: number;
  onResize: (key: CostsColumnKey, width: number) => void;
  onCommit: (key: CostsColumnKey, width: number) => void;
  onReset: (key: CostsColumnKey) => void;
}): JSX.Element {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // While dragging, nothing on the page selects and the cursor stays put
  // even when the pointer runs ahead of the handle.
  useEffect(() => {
    if (!dragging) return;
    const body = document.body.style;
    const previous = { userSelect: body.userSelect, cursor: body.cursor };
    body.userSelect = "none";
    body.cursor = "col-resize";
    return () => {
      body.userSelect = previous.userSelect;
      body.cursor = previous.cursor;
    };
  }, [dragging]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    onResize(column, drag.startWidth + event.clientX - drag.startX);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(column, drag.startWidth + event.clientX - drag.startX);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a column splitter, not a rule
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      data-testid={`costs-col-resize-${column}`}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onReset(column);
      }}
      className="group absolute -right-1.5 top-0 z-10 flex h-full w-3 cursor-col-resize touch-none select-none justify-center"
    >
      <span
        className={cn(
          "h-full w-px bg-transparent transition-colors group-hover:bg-primary/50",
          dragging && "bg-primary",
        )}
      />
    </div>
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
  const subtasks = row.subtaskUsage
    ? `${row.subtaskUsage.count} ${row.subtaskUsage.count === 1 ? "subtask" : "subtasks"}`
    : undefined;
  const cost = costFigure(row);
  const tokenCell =
    usage.status === "ready" ? (
      <span
        title={
          subtasks
            ? `Incl. ${subtasks} · own ${tokens.toLocaleString()}`
            : undefined
        }
      >
        <FigureText figure={tokensFigure(row)} />
      </span>
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
      <td className="truncate py-1.5 pr-3 text-foreground" title={row.title}>
        {row.title}
        {subtasks && (
          <span
            className="ml-1.5 text-muted-foreground"
            data-testid="costs-row-subtasks"
          >
            ⤷ {subtasks}
          </span>
        )}
      </td>
      <td
        className="truncate py-1.5 pr-3 font-mono text-muted-foreground"
        title={row.repository || undefined}
      >
        {row.repository || "—"}
      </td>
      <td
        className="truncate py-1.5 pr-3 font-mono text-muted-foreground"
        title={row.harness}
      >
        {row.harness}
      </td>
      <td
        className="truncate py-1.5 pr-3 font-mono text-muted-foreground"
        title={usage.byModel.map((model) => model.model).join(", ")}
      >
        {usage.byModel.map((model) => model.model).join(", ") || "—"}
      </td>
      <td
        className="truncate py-1.5 pr-3 text-right font-mono text-foreground"
        data-testid="costs-row-tokens"
      >
        {tokenCell}
      </td>
      <td
        className="truncate py-1.5 text-right font-mono text-muted-foreground"
        data-testid="costs-row-cost"
      >
        {cost ? <FigureText figure={cost} /> : "—"}
      </td>
    </tr>
  );
}

/** `"<incl> · own <own>"` (own muted) when they differ at this precision; else the one figure. */
function FigureText({ figure }: { figure: UsageFigure }): JSX.Element {
  if (figure.own === undefined) return <>{figure.primary}</>;
  return (
    <>
      <span className="font-semibold">{figure.primary}</span>
      <span className="text-muted-foreground">{` · own ${figure.own}`}</span>
    </>
  );
}
