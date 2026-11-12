// The inbox view (docs/release-plan.md "Inbox"): a third top-level view next
// to the workspace and the board, reached by the sidebar's Inbox row or
// Cmd+I; the sidebar stays. Two tabs (Priority / Other), a ~380px list
// grouped by task (unbound items in their own group) and the selected
// item's detail pane. Each row shows ONE primary action on hover/selection,
// everything else behind "…" and the keys (J/K/arrows, Enter/O, A/R, E, C,
// D, H, Tab, Esc). Items come from lib/use-inbox.ts; nothing here pops up
// on its own.
import {
  Check,
  CircleDot,
  CircleHelp,
  ExternalLink,
  Flag,
  Inbox as InboxIcon,
  Mail,
  MoreHorizontal,
  SquareCheck,
  X,
  Zap,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import logoGlyph from "../../../../build/logo-glyph.svg?raw";
import type {
  AuditEntry,
  Task,
  TaskMessage,
  TaskState,
} from "../../../preload/api";
import { flattenBoard, useBoard } from "../core-client";
import {
  groupEntries,
  type InboxAction,
  type InboxEntry,
  type InboxGroup,
  type InboxKind,
  type InboxTab,
  moveSelection,
  navigationOrder,
  selectionAfterRemoval,
  snoozePresets,
} from "../lib/inbox-items";
import { type InlineToken, parseMarkdown } from "../lib/inbox-markdown";
import { isTypingTarget } from "../lib/keyboard-guard";
import { modKeyLabel } from "../lib/platform";
import { toDoneMutation } from "../lib/task-mutations";
import { mountedTaskTail } from "../lib/terminal-tail";
import { relativeTime } from "../lib/time-format";
import type { InboxModel } from "../lib/use-inbox";
import { useNow } from "../lib/use-now";
import { cn } from "../lib/utils";
import { pushToast } from "../toast";
import {
  ApprovalDetail,
  type ApprovalDraft,
  approvalDraftOf,
  decideApproval,
} from "./ApprovalDetail";
import { pullRequestUrl, stateChipLabel } from "./sidebar-model";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Segmented } from "./ui/segmented";

/** The Harbormaster glyph (build/logo-glyph.svg), inline so it takes the text color. */
export function LogoGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn("inline-block [&>svg]:h-full [&>svg]:w-full", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own static, bundled SVG file (no user input).
      dangerouslySetInnerHTML={{ __html: logoGlyph }}
    />
  );
}

const KIND_GLYPH: Record<InboxKind, { icon: ReactNode; label: string }> = {
  asked: {
    icon: <CircleHelp className="text-status-needsYou" />,
    label: "Agent asked",
  },
  reported: {
    icon: <Check className="text-status-ok" />,
    label: "Agent reported",
  },
  approval: {
    icon: <Mail className="text-status-needsYou" />,
    label: "Approval",
  },
  rule: { icon: <Zap className="text-muted-foreground" />, label: "Rule" },
  "launch-failed": {
    icon: <X className="text-status-error" />,
    label: "Launch failed",
  },
  "ready-to-land": {
    icon: <Flag className="text-status-ok" />,
    label: "Ready to land",
  },
  idle: {
    icon: <CircleDot className="text-muted-foreground" />,
    label: "Your move",
  },
  done: {
    icon: <SquareCheck className="text-muted-foreground" />,
    label: "Done, wants a look",
  },
};

function actionTitle(action: InboxAction): string {
  return action.key ? `${action.label} (${action.key})` : action.label;
}

/**
 * The inbox view. `active` gates its keys (it stays mounted while hidden);
 * `onOpenTask` is App's guarded open path (takeover check), which also
 * switches to the workspace view.
 */
export function InboxView({
  model,
  active,
  onOpenTask,
  onBack,
}: {
  model: InboxModel;
  active: boolean;
  onOpenTask: (taskId: string) => void;
  onBack: () => void;
}): JSX.Element {
  const columns = useBoard();
  const rows = useMemo(() => flattenBoard(columns), [columns]);
  const tasks = useMemo(
    () => new Map(rows.map((row) => [row.task.id, row])),
    [rows],
  );
  const now = useNow();
  const [tab, setTab] = useState<InboxTab>("priority");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [editSignal, setEditSignal] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, ApprovalDraft>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Take focus from whatever had it (a now-hidden terminal), so the keys work.
  useEffect(() => {
    if (active) rootRef.current?.focus();
  }, [active]);

  const priorityGroups = useMemo(
    () => groupEntries(model.entries, model.priorities, "priority"),
    [model.entries, model.priorities],
  );
  const otherGroups = useMemo(
    () => groupEntries(model.entries, model.priorities, "other"),
    [model.entries, model.priorities],
  );
  const groups = tab === "priority" ? priorityGroups : otherGroups;
  const order = useMemo(() => navigationOrder(groups), [groups]);
  const byId = useMemo(
    () => new Map(model.entries.map((entry) => [entry.id, entry])),
    [model.entries],
  );

  // Keep a selection: the first item, or the removed item's neighbor.
  const previousOrder = useRef<string[]>([]);
  useEffect(() => {
    setSelectedId((current) => {
      if (current && order.includes(current)) return current;
      if (current) {
        return selectionAfterRemoval(previousOrder.current, order, current);
      }
      return order[0] ?? null;
    });
    previousOrder.current = order;
  }, [order]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const draftFor = useCallback(
    (message: TaskMessage): ApprovalDraft =>
      drafts[message.id] ?? approvalDraftOf(message),
    [drafts],
  );

  const runAction = useCallback(
    async (entry: InboxEntry, actionId: string): Promise<void> => {
      const taskId = entry.taskId;
      switch (actionId) {
        case "open":
          if (taskId) onOpenTask(taskId);
          return;
        case "dismiss":
          await model.dismiss(entry);
          return;
        case "to-done":
        case "mark-done":
          if (taskId) await toDoneMutation(taskId);
          return;
        case "approve":
        case "reject":
          if (entry.message) {
            await decideApproval(
              entry.message,
              actionId,
              draftFor(entry.message),
            );
          }
          return;
        case "edit":
          setSelectedId(entry.id);
          setEditSignal((count) => count + 1);
          return;
        case "retry":
          if (!taskId) return;
          try {
            const started = await window.harbormaster.core.retryLaunch(taskId);
            pushToast(
              started ? "Launch restarted" : "Launch failed again",
              started ? "success" : "error",
            );
          } catch (error) {
            pushToast(error instanceof Error ? error.message : String(error));
          }
          return;
        default:
          break;
      }
      if (actionId.startsWith("button:") && entry.item) {
        const buttonId = actionId.slice("button:".length);
        const button = entry.item.buttons.find((b) => b.id === buttonId);
        try {
          const result = await window.harbormaster.core.resolveInboxItem(
            entry.id,
            { buttonId },
          );
          if (button?.action === "openTask" && result.taskId) {
            onOpenTask(result.taskId);
          } else if (button?.action === "createTask" && result.taskId) {
            const created = result.taskId;
            pushToast(`Created: ${button.label}`, "success", {
              label: "Open",
              run: () => onOpenTask(created),
            });
          }
        } catch (error) {
          pushToast(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [model, onOpenTask, draftFor],
  );

  const actionByKey = useCallback(
    (entry: InboxEntry, key: string): InboxAction | undefined =>
      entry.actions.find((action) => action.key === key),
    [],
  );

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented) return;
      // A menu / snooze picker handles its own keys.
      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }
      if (event.key === "Escape") {
        if (isTypingTarget(event.target)) {
          (event.target as HTMLElement).blur();
          return;
        }
        event.preventDefault();
        onBack();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.key === "Tab") {
        event.preventDefault();
        setTab((current) => (current === "priority" ? "other" : "priority"));
        setSelectedId(null);
        return;
      }
      const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
      if (
        key === "J" ||
        key === "ArrowDown" ||
        key === "K" ||
        key === "ArrowUp"
      ) {
        event.preventDefault();
        const delta = key === "J" || key === "ArrowDown" ? 1 : -1;
        setSelectedId((current) => moveSelection(order, current, delta));
        return;
      }
      if (!selected) return;
      if (key === "Enter" || key === "O") {
        event.preventDefault();
        const open = actionByKey(selected, "O");
        if (open) void runAction(selected, open.id);
        else if (selected.taskId) onOpenTask(selected.taskId);
        return;
      }
      if (key === "H") {
        event.preventDefault();
        setSnoozeFor(selected.id);
        return;
      }
      if (key === "D" && !selected.dismissable && !actionByKey(selected, "D")) {
        pushToast(
          selected.kind === "approval"
            ? "An approval can't be dismissed: approve or reject it"
            : "A live question leaves when the agent's state changes",
          "warning",
        );
        return;
      }
      if (["A", "R", "E", "C", "D"].includes(key)) {
        const action = actionByKey(selected, key);
        if (!action) return;
        event.preventDefault();
        void runAction(selected, action.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, order, selected, onBack, onOpenTask, runAction, actionByKey]);

  // Keep the selected row in view as J/K move it.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector(`[data-entry-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const otherDismissable = otherGroups.some((group) =>
    group.entries.some((entry) => entry.dismissable),
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="inbox-view"
      data-tab={tab}
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <LogoGlyph className="h-4 w-4 text-foreground" />
        <span className="text-sm font-medium">Inbox</span>
        <Segmented
          ariaLabel="Inbox tabs"
          size="sm"
          className="ml-2"
          value={tab}
          onValueChange={(name) => {
            setTab(name);
            setSelectedId(null);
          }}
          options={(["priority", "other"] as const).map((name) => ({
            value: name,
            label: name === "priority" ? "Priority" : "Other",
            title: "Switch tab (Tab)",
            testId: `inbox-tab-${name}`,
            trailing: (
              <span
                data-testid={`inbox-tab-${name}-count`}
                className="font-normal tabular-nums text-muted-foreground"
              >
                {(name === "priority" ? priorityGroups : otherGroups).reduce(
                  (sum, group) => sum + group.entries.length,
                  0,
                )}
              </span>
            ),
          }))}
        />
        <div className="ml-auto flex items-center gap-2">
          {tab === "other" && otherDismissable && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="inbox-clear-other"
              onClick={() => void model.clearOther()}
              title="Dismiss everything in Other"
            >
              Clear Other
            </Button>
          )}
          <span className="hidden text-[11px] text-muted-foreground lg:inline">
            <Kbd>J</Kbd>/<Kbd>K</Kbd> move · <Kbd>O</Kbd> open · <Kbd>H</Kbd>{" "}
            snooze · <Kbd>Esc</Kbd> back
          </span>
        </div>
      </header>
      {order.length === 0 ? (
        <EmptyState
          tab={tab}
          workingCount={model.workingCount}
          otherCount={otherGroups.length}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            ref={listRef}
            data-testid="inbox-list"
            className="w-[380px] shrink-0 overflow-y-auto border-r border-border"
          >
            {groups.map((group) => (
              <GroupBlock
                key={group.key}
                group={group}
                task={group.taskId ? tasks.get(group.taskId) : undefined}
                selectedId={selectedId}
                now={now}
                snoozeFor={snoozeFor}
                onSnoozeFor={setSnoozeFor}
                onSelect={setSelectedId}
                onAction={(entry, id) => void runAction(entry, id)}
                onSnooze={(entry, until) => {
                  setSnoozeFor(null);
                  void model.snooze(entry, until);
                }}
              />
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <DetailPane
                key={selected.id}
                entry={selected}
                row={selected.taskId ? tasks.get(selected.taskId) : undefined}
                draft={
                  selected.message ? draftFor(selected.message) : undefined
                }
                onDraftChange={(draft) =>
                  selected.message &&
                  setDrafts((previous) => ({
                    ...previous,
                    [selected.message?.id ?? ""]: draft,
                  }))
                }
                editSignal={editSignal}
                onAction={(id) => void runAction(selected, id)}
                now={now}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({
  tab,
  workingCount,
  otherCount,
}: {
  tab: InboxTab;
  workingCount: number;
  otherCount: number;
}): JSX.Element {
  return (
    <div
      data-testid="inbox-empty"
      className="flex flex-1 flex-col items-center justify-center gap-3 text-center"
    >
      <LogoGlyph className="h-14 w-14 text-muted-foreground/60" />
      <p className="text-sm font-medium">
        {tab === "priority" ? "Nothing needs you" : "Nothing else here"}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="inbox-working">
        {workingCount === 0
          ? "No agents working"
          : `${workingCount} agent${workingCount === 1 ? "" : "s"} working`}
        {tab === "priority" && otherCount > 0 ? " · more in Other (Tab)" : ""}
      </p>
    </div>
  );
}

function contextLine(row: { task: Task } | undefined): string {
  if (!row) return "";
  const repo = row.task.repositoryId?.split("/").slice(-1)[0];
  return [row.task.title, repo, row.task.branch].filter(Boolean).join(" · ");
}

function GroupBlock({
  group,
  task,
  selectedId,
  now,
  snoozeFor,
  onSnoozeFor,
  onSelect,
  onAction,
  onSnooze,
}: {
  group: InboxGroup;
  task: { task: Task; state: TaskState } | undefined;
  selectedId: string | null;
  now: number;
  snoozeFor: string | null;
  onSnoozeFor: (id: string | null) => void;
  onSelect: (id: string) => void;
  onAction: (entry: InboxEntry, actionId: string) => void;
  onSnooze: (entry: InboxEntry, until: Date) => void;
}): JSX.Element {
  return (
    <section
      data-testid={`inbox-group-${group.key}`}
      className="flex flex-col gap-1.5 pb-2"
    >
      <h3 className="truncate px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {group.taskId ? (task?.task.title ?? "Task") : "Not about a task"}
      </h3>
      {group.entries.map((entry) => (
        <InboxRow
          key={entry.id}
          entry={entry}
          context={contextLine(task)}
          selected={entry.id === selectedId}
          now={now}
          snoozeOpen={snoozeFor === entry.id}
          onSnoozeOpenChange={(open) => onSnoozeFor(open ? entry.id : null)}
          onSelect={() => onSelect(entry.id)}
          onAction={(id) => onAction(entry, id)}
          onSnooze={(until) => onSnooze(entry, until)}
        />
      ))}
    </section>
  );
}

function InboxRow({
  entry,
  context,
  selected,
  now,
  snoozeOpen,
  onSnoozeOpenChange,
  onSelect,
  onAction,
  onSnooze,
}: {
  entry: InboxEntry;
  context: string;
  selected: boolean;
  now: number;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
  onSelect: () => void;
  onAction: (actionId: string) => void;
  onSnooze: (until: Date) => void;
}): JSX.Element {
  const glyph = KIND_GLYPH[entry.kind];
  const [primary, ...rest] = entry.actions;
  const [customUntil, setCustomUntil] = useState("");
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row hosts buttons, so it can't be a <button>.
    <div
      role="button"
      tabIndex={-1}
      data-testid={`inbox-row-${entry.id}`}
      data-entry-id={entry.id}
      data-kind={entry.kind}
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={() => {}}
      className={cn(
        // Design system "Cards" (inbox rows): bg-card, hairline, radius;
        // hover = border-foreground/20, selected = border-primary.
        "group/row relative mx-2 flex cursor-default items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 outline-none transition-colors duration-[120ms] ease-out hover:border-foreground/20",
        selected && "border-primary hover:border-primary",
      )}
    >
      <span
        className="mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4"
        title={glyph.label}
        data-testid="inbox-glyph"
      >
        {glyph.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="min-w-0 flex-1 truncate text-sm"
            data-testid="inbox-title"
            title={entry.title}
          >
            {entry.title}
          </span>
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground"
            title={entry.createdAt}
          >
            {relativeTime(entry.createdAt, now)}
          </span>
        </div>
        {context && (
          <div className="truncate text-xs text-muted-foreground">
            {context}
          </div>
        )}
      </div>
      <div
        className={cn(
          "absolute right-2 top-1.5 flex items-center gap-1 rounded-lg bg-card pl-1",
          selected || snoozeOpen
            ? "flex"
            : "hidden group-hover/row:flex group-focus-within/row:flex",
        )}
      >
        {primary && (
          <Button
            size="sm"
            variant="secondary"
            // Compact inline-row action (denser than `sm`): it overlays the
            // row's right edge, so it stays as narrow as before.
            className="h-6 gap-1 px-2 text-xs"
            data-testid="inbox-primary"
            title={actionTitle(primary)}
            onClick={(event) => {
              event.stopPropagation();
              onAction(primary.id);
            }}
          >
            {primary.label}
            {primary.key && <Kbd>{primary.key}</Kbd>}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              aria-label="More actions"
              title="More actions"
              data-testid="inbox-more"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            data-testid="inbox-menu"
            onClick={(event) => event.stopPropagation()}
          >
            {rest.map((action) => (
              <DropdownMenuItem
                key={action.id}
                data-testid={`inbox-menu-${action.id}`}
                onSelect={() => onAction(action.id)}
              >
                {action.label}
                {action.key && (
                  <DropdownMenuShortcut>{action.key}</DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ))}
            {rest.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="inbox-menu-snooze">
                Snooze
                <DropdownMenuShortcut>H</DropdownMenuShortcut>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-testid="inbox-snooze-menu">
                <SnoozeItems onSnooze={onSnooze} />
                <DropdownMenuSeparator />
                <div className="flex items-center gap-1 px-2 py-1">
                  <Input
                    type="datetime-local"
                    aria-label="Snooze until"
                    data-testid="inbox-snooze-date"
                    className="h-7 text-[13px]"
                    value={customUntil}
                    onChange={(event) => setCustomUntil(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  <Button
                    size="sm"
                    data-testid="inbox-snooze-date-apply"
                    disabled={
                      !customUntil || Number.isNaN(Date.parse(customUntil))
                    }
                    onClick={() => onSnooze(new Date(customUntil))}
                  >
                    Snooze
                  </Button>
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* H opens the snooze presets directly (a menu of its own). */}
      {snoozeOpen && (
        <SnoozeKeyMenu
          onSnooze={onSnooze}
          onClose={() => onSnoozeOpenChange(false)}
        />
      )}
    </div>
  );
}

function SnoozeItems({
  onSnooze,
}: {
  onSnooze: (until: Date) => void;
}): JSX.Element {
  const presets = snoozePresets(new Date());
  return (
    <>
      {presets.map((preset) => (
        <DropdownMenuItem
          key={preset.id}
          data-testid={`inbox-snooze-${preset.id}`}
          onSelect={() => onSnooze(preset.until)}
        >
          {preset.label}
          <DropdownMenuShortcut>
            {preset.until.toLocaleString([], {
              weekday: "short",
              hour: "numeric",
              minute: "2-digit",
            })}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** The H key's snooze picker: presets as buttons (1-4), Esc closes. */
function SnoozeKeyMenu({
  onSnooze,
  onClose,
}: {
  onSnooze: (until: Date) => void;
  onClose: () => void;
}): JSX.Element {
  const presets = snoozePresets(new Date());
  const firstRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: key boundary for the preset buttons inside.
    <div
      data-testid="inbox-snooze-picker"
      className="absolute right-2 top-9 z-40 flex w-56 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
        const index = Number(event.key) - 1;
        const preset = presets[index];
        if (preset) onSnooze(preset.until);
      }}
    >
      {presets.map((preset, index) => (
        <button
          key={preset.id}
          ref={index === 0 ? firstRef : undefined}
          type="button"
          data-testid={`inbox-snooze-key-${preset.id}`}
          className="flex items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors duration-[120ms] ease-out hover:bg-accent focus:bg-accent focus:outline-none"
          onClick={() => onSnooze(preset.until)}
        >
          {preset.label}
          <Kbd>{index + 1}</Kbd>
        </button>
      ))}
    </div>
  );
}

function Inline({ tokens }: { tokens: InlineToken[] }): JSX.Element {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${index}-${token.type}`;
        switch (token.type) {
          case "bold":
            return <strong key={key}>{token.text}</strong>;
          case "code":
            return (
              <code
                key={key}
                className="rounded bg-muted px-1 font-mono text-[12px]"
              >
                {token.text}
              </code>
            );
          case "link":
            return (
              <a
                key={key}
                href={token.href}
                className="text-foreground underline decoration-border underline-offset-2 hover:text-primary hover:decoration-primary"
                onClick={(event) => {
                  event.preventDefault();
                  void window.harbormaster.shell.openExternal(token.href);
                }}
              >
                {token.text}
              </a>
            );
          default:
            return <span key={key}>{token.text}</span>;
        }
      })}
    </>
  );
}

function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = parseMarkdown(text);
  return (
    <div
      className="flex flex-col gap-2 text-sm"
      data-testid="inbox-detail-body"
    >
      {blocks.map((block, index) => {
        const key = `${index}-${block.type}`;
        switch (block.type) {
          case "heading":
            return (
              <p key={key} className="font-semibold">
                <Inline tokens={block.inline} />
              </p>
            );
          case "list":
            return (
              <ul key={key} className="list-disc pl-5">
                {block.items.map((item, itemIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static parsed text.
                  <li key={itemIndex}>
                    <Inline tokens={item} />
                  </li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs"
              >
                {block.text}
              </pre>
            );
          default:
            return (
              <p key={key}>
                <Inline tokens={block.inline} />
              </p>
            );
        }
      })}
    </div>
  );
}

/** The task's last ~30 terminal lines, as static text (no live mirror in v1). */
function TerminalTail({ taskId }: { taskId: string }): JSX.Element | null {
  const [tail, setTail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const mounted = mountedTaskTail(taskId);
    if (mounted !== undefined) {
      setTail(mounted);
      return;
    }
    void window.harbormaster.core
      .terminalTail(taskId)
      .then((text) => {
        if (!cancelled) setTail(text);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  if (!tail) return null;
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Last lines
      </h4>
      <pre
        data-testid="inbox-detail-terminal"
        className="max-h-[420px] overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px] leading-snug text-muted-foreground"
      >
        {tail}
      </pre>
    </section>
  );
}

/** A rule item's source facts: the triggering event's data from the audit log. */
function RuleFacts({ eventId }: { eventId: string }): JSX.Element | null {
  const [facts, setFacts] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core
      .listEvents({ limit: 2000 })
      .then((entries: AuditEntry[]) => {
        if (cancelled) return;
        const event = entries.find(
          (entry) => entry.kind === "event" && entry.event.id === eventId,
        );
        const data =
          event?.kind === "event" &&
          event.event.data &&
          typeof event.event.data === "object"
            ? (event.event.data as Record<string, unknown>)
            : null;
        setFacts(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [eventId]);
  if (!facts) return null;
  const pairs = Object.entries(facts).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  if (pairs.length === 0) return null;
  return (
    <dl
      className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs"
      data-testid="inbox-detail-facts"
    >
      {pairs.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DetailPane({
  entry,
  row,
  draft,
  onDraftChange,
  editSignal,
  onAction,
  now,
}: {
  entry: InboxEntry;
  row: { task: Task; state: TaskState } | undefined;
  draft: ApprovalDraft | undefined;
  onDraftChange: (draft: ApprovalDraft) => void;
  editSignal: number;
  onAction: (actionId: string) => void;
  now: number;
}): JSX.Element {
  const glyph = KIND_GLYPH[entry.kind];
  const prUrl = row ? pullRequestUrl(row.task) : undefined;
  return (
    <div
      data-testid="inbox-detail"
      data-entry-id={entry.id}
      className="flex max-w-3xl flex-col gap-4 p-5"
    >
      {row && (
        <header className="flex flex-col gap-1" data-testid="inbox-detail-task">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-base font-semibold">
              {row.task.title}
            </span>
            <span className="shrink-0 rounded-full border border-border bg-muted px-2 text-[11px] text-muted-foreground">
              {stateChipLabel(row.task, row.state)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {row.task.branch && (
              <span className="truncate font-mono">{row.task.branch}</span>
            )}
            {row.task.pr && (
              <button
                type="button"
                className="flex items-center gap-1 hover:text-foreground"
                disabled={!prUrl}
                onClick={() =>
                  prUrl && void window.harbormaster.shell.openExternal(prUrl)
                }
              >
                #{row.task.pr.number}
                {row.task.pr.role === "reviewer" ? " (reviewing)" : ""}
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
        </header>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="[&>svg]:h-4 [&>svg]:w-4">{glyph.icon}</span>
        {glyph.label}
        <span title={entry.createdAt}>
          · {relativeTime(entry.createdAt, now)}
        </span>
      </div>

      {entry.kind === "approval" && entry.message && draft ? (
        <ApprovalDetail
          message={entry.message}
          targetTitle={row?.task.title ?? "Task"}
          draft={draft}
          onDraftChange={onDraftChange}
          editSignal={editSignal}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {entry.actions.map((action, index) => (
              <Button
                key={action.id}
                size="sm"
                variant={index === 0 ? "default" : "secondary"}
                data-testid={`inbox-action-${action.id}`}
                title={actionTitle(action)}
                onClick={() => onAction(action.id)}
              >
                {action.label}
                {action.key && <Kbd>{action.key}</Kbd>}
              </Button>
            ))}
            {entry.kind !== "asked" &&
              !entry.actions.some((action) => action.id === "open") &&
              entry.taskId && (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="inbox-action-open"
                  title="Open (O)"
                  onClick={() => onAction("open")}
                >
                  Open
                  <Kbd>O</Kbd>
                </Button>
              )}
          </div>
          <h2
            className="whitespace-pre-wrap text-sm font-medium"
            data-testid="inbox-detail-title"
          >
            {entry.title}
          </h2>
          {entry.kind === "rule" ? (
            <>
              {entry.body && <Markdown text={entry.body} />}
              {entry.item?.eventId && (
                <RuleFacts eventId={entry.item.eventId} />
              )}
            </>
          ) : entry.body && entry.body !== entry.title ? (
            <p
              className="whitespace-pre-wrap text-sm"
              data-testid="inbox-detail-body"
            >
              {entry.body}
            </p>
          ) : null}
          {entry.kind === "launch-failed" && row?.task.initialPrompt && (
            <section className="flex flex-col gap-1">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Launch prompt
              </h4>
              <pre className="whitespace-pre-wrap rounded-md border border-border p-2 text-xs">
                {row.task.initialPrompt}
              </pre>
            </section>
          )}
          {entry.taskId &&
            entry.kind !== "rule" &&
            entry.kind !== "launch-failed" && (
              <TerminalTail taskId={entry.taskId} />
            )}
        </>
      )}
    </div>
  );
}

/** The board header's inbox button: icon + Priority count (hidden at zero), opens the inbox view. */
export function InboxHeaderButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      size="sm"
      variant="secondary"
      data-testid="board-inbox-button"
      title={`Inbox (${modKeyLabel()}I)`}
      aria-label={count > 0 ? `Inbox: ${count}` : "Inbox"}
      onClick={onClick}
    >
      <InboxIcon className="h-3.5 w-3.5" aria-hidden />
      <span>Inbox</span>
      {count > 0 && (
        <span
          data-testid="board-inbox-button-count"
          className="rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-4 text-primary-foreground"
        >
          {count}
        </span>
      )}
    </Button>
  );
}
