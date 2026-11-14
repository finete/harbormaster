// The Rules page's Activity tab (docs/rules-page.md decisions 7, 15): the
// last 30 days of the rules audit log (`listEvents({ since })`), actions
// and warnings by default with a "show events" toggle, newest first under
// day headers. Filters (rule, task, outcome) are removable chips; an
// action row expands to its triggering event's `data` (found by `eventId`
// in the same result set); a rule name jumps back to the Rules tab with
// that rule's sheet open.
import { ChevronDown, ChevronRight, ListFilter, X } from "lucide-react";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import type {
  AuditEntry,
  RuleActionOutcome,
  RulesListing,
} from "../../../preload/api";
import { auditActionVerb, auditRuleLabel, humanize } from "../lib/audit-lines";
import {
  type ActivityFilter,
  activityEntries,
  DOT_CLASS,
  dayLabel,
  groupByDay,
  outcomeDot,
  type RuleKey,
  ruleKeyString,
  triggeringEvent,
} from "../lib/rules-format";
import { cn } from "../lib/utils";
import { TaskLink } from "./RuleSheet";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const OUTCOMES: RuleActionOutcome[] = [
  "applied",
  "stayed",
  "superseded",
  "skipped",
  "failed",
];

function without(
  filter: ActivityFilter,
  key: keyof ActivityFilter,
): ActivityFilter {
  const next = { ...filter };
  delete next[key];
  return next;
}

export function RulesActivity({
  entries,
  listing,
  filter,
  onFilterChange,
  showEvents,
  onShowEventsChange,
  now,
  taskTitle,
  onOpenTask,
  onOpenRule,
}: {
  /** `listEvents({ since })`, oldest first; `null` while loading. */
  entries: readonly AuditEntry[] | null;
  listing: RulesListing | null;
  filter: ActivityFilter;
  onFilterChange: (filter: ActivityFilter) => void;
  showEvents: boolean;
  onShowEventsChange: (show: boolean) => void;
  now: number;
  taskTitle: (taskId: string) => string | undefined;
  onOpenTask: (taskId: string) => void;
  onOpenRule: (key: RuleKey) => void;
}): JSX.Element {
  const all = entries ?? [];
  const rows = useMemo(
    () => activityEntries(all, filter, showEvents),
    [all, filter, showEvents],
  );
  const groups = useMemo(() => groupByDay(rows), [rows]);
  const ruleLabel = useMemo(() => {
    const labels = new Map<string, string>();
    for (const file of listing?.files ?? []) {
      for (const rule of file.rules) {
        labels.set(
          ruleKeyString({ file: rule.file, ruleId: rule.id }),
          rule.label,
        );
      }
    }
    return (key: RuleKey, fallback?: string): string =>
      labels.get(ruleKeyString(key)) ?? fallback ?? humanize(key.ruleId);
  }, [listing]);
  // Filter choices: what the loaded window actually contains.
  const choices = useMemo(() => {
    const rules = new Map<string, { key: RuleKey; label: string }>();
    const tasks = new Set<string>();
    for (const entry of all) {
      if (entry.kind === "action") {
        const key = { file: entry.file, ruleId: entry.ruleId };
        rules.set(ruleKeyString(key), {
          key,
          label: ruleLabel(key, entry.ruleLabel),
        });
      }
      if (entry.kind !== "event" && entry.taskId) tasks.add(entry.taskId);
    }
    return { rules: [...rules.values()], tasks: [...tasks] };
  }, [all, ruleLabel]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const chips: Array<{ id: string; text: string; clear: () => void }> = [];
  if (filter.rule) {
    chips.push({
      id: "rule",
      text: `Rule: ${ruleLabel(filter.rule)}`,
      clear: () => onFilterChange(without(filter, "rule")),
    });
  }
  if (filter.taskId) {
    chips.push({
      id: "task",
      text: `Task: ${taskTitle(filter.taskId) ?? filter.taskId}`,
      clear: () => onFilterChange(without(filter, "taskId")),
    });
  }
  if (filter.outcome) {
    chips.push({
      id: "outcome",
      text: `Outcome: ${filter.outcome}`,
      clear: () => onFilterChange(without(filter, "outcome")),
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="rules-activity">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              data-testid="rules-activity-add-filter"
            >
              <ListFilter aria-hidden />
              Filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={choices.rules.length === 0}>
                Rule
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {choices.rules.map((choice) => (
                  <DropdownMenuItem
                    key={ruleKeyString(choice.key)}
                    onSelect={() =>
                      onFilterChange({ ...filter, rule: choice.key })
                    }
                  >
                    {choice.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={choices.tasks.length === 0}>
                Task
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {choices.tasks.map((taskId) => (
                  <DropdownMenuItem
                    key={taskId}
                    onSelect={() => onFilterChange({ ...filter, taskId })}
                  >
                    {taskTitle(taskId) ?? taskId}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Outcome</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {OUTCOMES.map((outcome) => (
                  <DropdownMenuItem
                    key={outcome}
                    onSelect={() => onFilterChange({ ...filter, outcome })}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        DOT_CLASS[outcomeDot(outcome)],
                      )}
                    />
                    {outcome}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {chips.map((chip) => (
          <span
            key={chip.id}
            data-testid={`rules-activity-filter-${chip.id}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted py-px pl-2 pr-1 text-xs text-foreground"
          >
            {chip.text}
            <button
              type="button"
              aria-label={`Remove ${chip.id} filter`}
              data-testid={`rules-activity-filter-${chip.id}-remove`}
              onClick={chip.clear}
              className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-pressed={showEvents}
          data-testid="rules-activity-show-events"
          onClick={() => onShowEventsChange(!showEvents)}
        >
          {showEvents ? "Hide events" : "Show events"}
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto py-2"
        data-testid="rules-activity-list"
      >
        {entries === null ? null : groups.length === 0 ? (
          <p
            className="px-4 py-8 text-center text-sm text-muted-foreground"
            data-testid="rules-activity-empty"
          >
            {chips.length > 0
              ? "Nothing matches these filters."
              : "No rule activity in the last 30 days."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.day} className="flex flex-col pb-2">
              <h3
                className="sticky top-0 bg-background px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                data-testid="rules-activity-day"
              >
                {dayLabel(group.day, now)}
              </h3>
              {group.entries.map((entry, index) => {
                const id = `${entry.at}-${index}`;
                return (
                  <ActivityRow
                    key={id}
                    entry={entry}
                    all={all}
                    expanded={expanded === id}
                    onToggle={() =>
                      setExpanded((current) => (current === id ? null : id))
                    }
                    ruleLabel={ruleLabel}
                    taskTitle={taskTitle}
                    onOpenTask={onOpenTask}
                    onOpenRule={onOpenRule}
                  />
                );
              })}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
}

function ActivityRow({
  entry,
  all,
  expanded,
  onToggle,
  ruleLabel,
  taskTitle,
  onOpenTask,
  onOpenRule,
}: {
  entry: AuditEntry;
  all: readonly AuditEntry[];
  expanded: boolean;
  onToggle: () => void;
  ruleLabel: (key: RuleKey, fallback?: string) => string;
  taskTitle: (taskId: string) => string | undefined;
  onOpenTask: (taskId: string) => void;
  onOpenRule: (key: RuleKey) => void;
}): JSX.Element {
  const time = (
    <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
      {clock(entry.at)}
    </span>
  );
  if (entry.kind === "event") {
    return (
      <div
        data-testid="rules-activity-row"
        data-kind="event"
        className="flex items-baseline gap-2 px-4 py-0.5"
        title={entry.at}
      >
        {time}
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {entry.event.type}
        </span>
        {entry.event.subject && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
            {entry.event.subject}
          </span>
        )}
      </div>
    );
  }
  const ruleKey =
    entry.ruleId !== undefined && entry.file !== undefined
      ? { file: entry.file, ruleId: entry.ruleId }
      : undefined;
  const ruleName = ruleKey ? (
    <button
      type="button"
      data-testid="rules-activity-rule-link"
      onClick={(event) => {
        event.stopPropagation();
        onOpenRule(ruleKey);
      }}
      className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-px text-[11px] text-muted-foreground transition-colors duration-[120ms] ease-out hover:text-primary"
    >
      {ruleLabel(
        ruleKey,
        entry.kind === "action" ? auditRuleLabel(entry) : undefined,
      )}
    </button>
  ) : null;
  const task = entry.taskId ? (
    <TaskLink
      taskId={entry.taskId}
      title={taskTitle(entry.taskId)}
      onOpenTask={onOpenTask}
    />
  ) : null;
  if (entry.kind === "warning") {
    return (
      <div
        data-testid="rules-activity-row"
        data-kind="warning"
        className="flex items-baseline gap-2 px-4 py-1 text-xs"
        title={entry.at}
      >
        {time}
        <span className="min-w-0 flex-1 truncate text-status-needsYou">
          Warning: {entry.message}
        </span>
        {task}
        {ruleName}
      </div>
    );
  }
  const trigger = expanded ? triggeringEvent(entry, all) : undefined;
  const dot = outcomeDot(entry.outcome);
  return (
    <div data-testid="rules-activity-row" data-kind="action">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        title={`${entry.eventType} · ${entry.file}:${entry.line}`}
        className="flex w-full items-baseline gap-2 px-4 py-1 text-left text-xs transition-colors duration-[120ms] ease-out hover:bg-accent/50"
      >
        {time}
        <span
          className={cn(
            "h-2 w-2 shrink-0 self-center rounded-full",
            DOT_CLASS[dot],
          )}
          data-dot={dot}
        />
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 self-center text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 self-center text-muted-foreground" />
        )}
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground"
          data-testid="rules-activity-verb"
        >
          {auditActionVerb(entry)}
        </span>
        {task}
        {ruleName}
      </button>
      {expanded && (
        <div
          data-testid="rules-activity-trigger"
          className="ml-[4.5rem] mr-4 mb-1 rounded-md border border-border bg-card px-3 py-2"
        >
          <div className="mb-1 font-mono text-[11px] text-muted-foreground">
            {entry.eventType}
          </div>
          {trigger?.kind === "event" ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
              {JSON.stringify(trigger.event.data ?? null, null, 2)}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              The triggering event is not in the loaded window.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
