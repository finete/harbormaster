// The selected rule's slide-over (docs/rules-page.md decisions 3, 5, 10,
// 15): non-modal, 560px, no scrim. Header (label, last-outcome dot,
// `id · file:line`, Open in editor), then On · If · Do and the rule's
// recent activity (`listEvents({ ruleId, file, limit: 5 })`). `If` is
// core's structure-only outline of the user's own CEL (never paraphrased);
// `js:` and unparsable conditions show their raw text.
import { ArrowRight, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  AuditEntry,
  CelOutline,
  Rule,
  RuleConditionView,
} from "../../../preload/api";
import { auditActionVerb, auditAge } from "../lib/audit-lines";
import {
  activityEntries,
  DOT_CLASS,
  DOT_TITLE,
  doChipText,
  type RuleKey,
  ruleDot,
  withSummary,
} from "../lib/rules-format";
import { cn } from "../lib/utils";
import { OpenInButton } from "./OpenInButton";

export const JS_CONDITION_HINT = "custom JavaScript — open the file to read it";

const SECTION =
  "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const CHIP =
  "inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[11px]";

export function RuleSheet({
  rule,
  path,
  now,
  revision,
  taskTitle,
  onOpenTask,
  onViewAllActivity,
  onClose,
}: {
  rule: Rule;
  /** The rule file's absolute path (Open in editor). */
  path: string;
  now: number;
  /** Changes on every listing re-read: refetch the recent activity then. */
  revision: number;
  /** A live task's title; undefined when the task is gone. */
  taskTitle: (taskId: string) => string | undefined;
  onOpenTask: (taskId: string) => void;
  onViewAllActivity: (key: RuleKey) => void;
  onClose: () => void;
}): JSX.Element {
  const dot = ruleDot(rule.activity);
  return (
    <aside
      data-testid="rule-sheet"
      data-rule-id={rule.id}
      aria-label={`Rule ${rule.label}`}
      className="absolute inset-y-0 right-0 z-10 flex w-[560px] max-w-full flex-col border-l border-border bg-card"
    >
      <header className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            data-testid="rule-sheet-dot"
            data-dot={dot}
            title={DOT_TITLE[dot]}
            className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASS[dot])}
          />
          <h2
            className="min-w-0 flex-1 truncate text-base font-semibold"
            data-testid="rule-sheet-label"
          >
            {rule.label}
          </h2>
          <OpenInButton path={path || undefined} testId="rule-sheet-open-in" />
          <button
            type="button"
            data-testid="rule-sheet-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">
          {rule.id} · {rule.file}:{rule.line}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <section data-testid="rule-sheet-on" className="flex flex-col gap-1.5">
          <h3 className={SECTION}>On</h3>
          <div className="flex flex-wrap gap-1">
            {rule.on.map((glob) => (
              <span key={glob} className={cn(CHIP, "text-foreground")}>
                {glob}
              </span>
            ))}
          </div>
        </section>
        <section data-testid="rule-sheet-if" className="flex flex-col gap-1.5">
          <h3 className={SECTION}>If</h3>
          <Condition view={rule.condition} />
        </section>
        <section data-testid="rule-sheet-do" className="flex flex-col gap-1.5">
          <h3 className={SECTION}>Do</h3>
          <ul className="flex flex-col gap-1">
            {rule.do.map((spec, index) => {
              const summary = withSummary(spec);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: actions are positional.
                <li key={index} className="flex min-w-0 items-baseline gap-2">
                  <span className={cn(CHIP, "shrink-0 text-foreground")}>
                    {doChipText(spec)}
                  </span>
                  {summary && (
                    <span
                      className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                      title={summary}
                    >
                      {summary}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <RecentActivity
          rule={rule}
          now={now}
          revision={revision}
          taskTitle={taskTitle}
          onOpenTask={onOpenTask}
          onViewAll={() =>
            onViewAllActivity({ file: rule.file, ruleId: rule.id })
          }
        />
      </div>
    </aside>
  );
}

/** `rule.condition` as the page shows it: outline, raw text + error, js ref, or "always". */
export function Condition({ view }: { view: RuleConditionView }): JSX.Element {
  switch (view.kind) {
    case "always":
      return (
        <p className="text-sm text-muted-foreground" data-condition="always">
          always
        </p>
      );
    case "js":
      return (
        <div data-condition="js" className="flex flex-col gap-1">
          <code className="font-mono text-xs text-foreground">{view.ref}</code>
          <p className="text-xs text-muted-foreground">{JS_CONDITION_HINT}</p>
        </div>
      );
    case "cel-invalid":
      return (
        <div data-condition="cel-invalid" className="flex flex-col gap-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {view.source}
          </pre>
          <p className="text-xs text-status-error">{view.error}</p>
        </div>
      );
    case "cel":
      return (
        <div data-condition="cel" title={view.source}>
          <Outline node={view.outline} />
        </div>
      );
  }
}

function Outline({ node }: { node: CelOutline }): JSX.Element {
  if (node.kind === "leaf") {
    return (
      <code
        data-testid="rule-if-leaf"
        className="block whitespace-pre-wrap break-words font-mono text-xs text-foreground"
      >
        {node.text}
      </code>
    );
  }
  return (
    <div
      data-testid={`rule-if-${node.kind}`}
      className="grid grid-cols-[2.5rem_1fr] gap-x-2 gap-y-1"
    >
      {node.items.map((item, index) => (
        <OutlineItem
          // biome-ignore lint/suspicious/noArrayIndexKey: outline items are positional.
          key={index}
          label={index === 0 ? (node.kind === "all" ? "ALL" : "ANY") : ""}
          item={item}
        />
      ))}
    </div>
  );
}

function OutlineItem({
  label,
  item,
}: {
  label: string;
  item: CelOutline;
}): JSX.Element {
  return (
    <>
      <span className="pt-px text-[10px] font-semibold tracking-wider text-muted-foreground">
        {label}
      </span>
      {item.kind === "leaf" ? (
        <Outline node={item} />
      ) : (
        <div className="ml-1 border-l border-border pl-3">
          <Outline node={item} />
        </div>
      )}
    </>
  );
}

const RECENT_LIMIT = 5;

function RecentActivity({
  rule,
  now,
  revision,
  taskTitle,
  onOpenTask,
  onViewAll,
}: {
  rule: Rule;
  now: number;
  revision: number;
  taskTitle: (taskId: string) => string | undefined;
  onOpenTask: (taskId: string) => void;
  onViewAll: () => void;
}): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is a re-read trigger.
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core
      .listEvents({ ruleId: rule.id, file: rule.file, limit: RECENT_LIMIT })
      .then((list) => {
        if (cancelled) return;
        // Core already filters by rule; keep it honest client-side too.
        setEntries(
          activityEntries(
            list,
            { rule: { file: rule.file, ruleId: rule.id } },
            false,
          ).slice(0, RECENT_LIMIT),
        );
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rule.id, rule.file, revision]);

  return (
    <section
      data-testid="rule-sheet-activity"
      className="flex flex-col gap-1.5"
    >
      <h3 className={SECTION}>Recent activity</h3>
      {entries === null ? null : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing in the activity window.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {entries.map((entry, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: newest-first log lines.
              key={`${entry.at}-${index}`}
              data-kind={entry.kind}
              className="flex min-w-0 items-baseline gap-2 text-xs"
              title={entry.at}
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  entry.kind === "warning"
                    ? "text-status-needsYou"
                    : "font-medium text-foreground",
                )}
              >
                {entry.kind === "action"
                  ? auditActionVerb(entry)
                  : entry.kind === "warning"
                    ? `Warning: ${entry.message}`
                    : entry.event.type}
              </span>
              {entry.taskId && (
                <TaskLink
                  taskId={entry.taskId}
                  title={taskTitle(entry.taskId)}
                  onOpenTask={onOpenTask}
                />
              )}
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {auditAge(entry.at, now)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        data-testid="rule-sheet-view-all"
        onClick={onViewAll}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground transition-colors duration-[120ms] ease-out hover:text-primary"
      >
        View all activity for this rule
        <ArrowRight className="h-3 w-3" aria-hidden />
      </button>
    </section>
  );
}

/** A task title that opens the task's workspace; plain text (id in the tooltip) when the task is gone. */
export function TaskLink({
  taskId,
  title,
  onOpenTask,
}: {
  taskId: string;
  title: string | undefined;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  if (title === undefined) {
    return (
      <span
        className="min-w-0 truncate text-muted-foreground"
        title={`Task ${taskId} (no longer exists)`}
        data-testid="rules-task-gone"
      >
        deleted task
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="rules-task-link"
      title={`Open ${title}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpenTask(taskId);
      }}
      className="min-w-0 truncate text-muted-foreground underline-offset-2 transition-colors duration-[120ms] ease-out hover:text-primary hover:underline"
    >
      {title}
    </button>
  );
}
