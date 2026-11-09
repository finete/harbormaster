// The new-task composer's toolbar pickers (see /docs/new-task-composer.md):
// Where (Popover + Command, shadcn's Combobox pattern), Agent · Model
// (Dropdown Menu, after the AI Elements Model Selector), Parent and base
// branch (Popover + Command), and the split submit button. Each picker is
// controlled (`open`/`onOpenChange`) so the composer can open it from a
// keyboard shortcut and hand focus back to the prompt when it closes.

import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  CornerDownRight,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Link2,
  MessageSquare,
  Plus,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import type {
  HarnessModelCatalog,
  KnownLocation,
  RepositoryInfo,
  Task,
  ThinkingLevel,
} from "../../../preload/api";
import {
  type DraftMode,
  folderWhere,
  parseWhere,
  repoWhere,
  type SubmitAction,
  WHERE_CLONE,
  WHERE_NONE,
  type WhereToken,
} from "../lib/new-task-draft";
import { modKeyLabel } from "../lib/platform";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { InputGroupButton } from "./ui/input-group";
import { Kbd } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** Last path segment of a repository id or folder path. */
export function shortName(idOrPath: string): string {
  const segments = idOrPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? idOrPath;
}

function Check4({ on }: { on: boolean }): JSX.Element {
  return (
    <Check
      className={cn("ml-auto size-3.5", on ? "opacity-100" : "opacity-0")}
    />
  );
}

// --- Where -----------------------------------------------------------------

export interface WhereOption {
  token: WhereToken;
  label: string;
  detail?: string;
  kind: "repository" | "folder";
}

/** Every pickable location: repositories (incl. registered git folders), then non-git folders. */
export function whereOptions(
  repositories: readonly RepositoryInfo[],
  locations: readonly KnownLocation[],
): WhereOption[] {
  return [
    ...repositories.map(
      (repo): WhereOption => ({
        token: repoWhere(repo.id),
        label: shortName(repo.id),
        detail:
          repo.checkouts.length > 1
            ? `${repo.id} · ${repo.checkouts.length} checkouts`
            : repo.id,
        kind: "repository",
      }),
    ),
    ...locations
      .filter((location) => !location.repositoryId)
      .map(
        (location): WhereOption => ({
          token: folderWhere(location.path),
          label: location.name,
          detail: location.path,
          kind: "folder",
        }),
      ),
  ];
}

export function whereLabel(
  token: WhereToken,
  options: readonly WhereOption[],
): string {
  const where = parseWhere(token);
  switch (where.kind) {
    case "unset":
      return "Choose where…";
    case "none":
      return "No folder";
    case "clone":
      return "Clone URL";
    case "repository":
      return (
        options.find((option) => option.token === token)?.label ??
        shortName(where.repositoryId)
      );
    case "folder":
      return shortName(where.path);
  }
}

function whereIcon(token: WhereToken): JSX.Element {
  const where = parseWhere(token);
  if (where.kind === "none") return <Ban />;
  if (where.kind === "clone") return <Link2 />;
  if (where.kind === "folder") return <Folder />;
  return <FolderGit2 />;
}

export function WherePicker({
  value,
  options,
  recents,
  open,
  onOpenChange,
  onSelect,
  onOpenFolder,
}: {
  value: WhereToken;
  options: readonly WhereOption[];
  recents: readonly WhereToken[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: WhereToken) => void;
  onOpenFolder: () => void;
}): JSX.Element {
  const recentOptions = recents
    .map((token) => options.find((option) => option.token === token))
    .filter((option): option is WhereOption => !!option);
  const repositories = options.filter((option) => option.kind === "repository");
  const folders = options.filter((option) => option.kind === "folder");
  const item = (option: WhereOption, group: string): JSX.Element => (
    <CommandItem
      key={`${group}:${option.token}`}
      value={`${group} ${option.label} ${option.detail ?? ""}`}
      data-testid="new-task-where-option"
      data-where={option.token}
      onSelect={() => onSelect(option.token)}
    >
      {option.kind === "folder" ? <Folder /> : <FolderGit2 />}
      <span className="shrink-0">{option.label}</span>
      {option.detail && option.detail !== option.label && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {option.detail}
        </span>
      )}
      <Check4 on={value === option.token} />
    </CommandItem>
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <InputGroupButton
          data-testid="new-task-where"
          data-where={value}
          aria-label="Where"
          title={`Where it runs (${modKeyLabel()}P)`}
          className={cn(
            "min-w-0 max-w-[200px] shrink text-muted-foreground hover:text-foreground",
            !value && "text-amber-300/90",
          )}
        >
          {whereIcon(value)}
          <span className="truncate">{whereLabel(value, options)}</span>
          <ChevronDown className="opacity-60" />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent className="w-80" data-testid="new-task-where-menu">
        <Command>
          <CommandInput placeholder="Search repositories and folders…" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            {recentOptions.length > 0 && (
              <CommandGroup heading="Recent">
                {recentOptions.map((option) => item(option, "recent"))}
              </CommandGroup>
            )}
            {repositories.length > 0 && (
              <CommandGroup heading="Repositories">
                {repositories.map((option) => item(option, "repository"))}
              </CommandGroup>
            )}
            {folders.length > 0 && (
              <CommandGroup heading="Folders">
                {folders.map((option) => item(option, "folder"))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="action open folder"
                data-testid="new-task-where-open-folder"
                onSelect={onOpenFolder}
              >
                <FolderOpen />
                Open folder…
              </CommandItem>
              <CommandItem
                value="action clone url"
                data-testid="new-task-where-clone"
                onSelect={() => onSelect(WHERE_CLONE)}
              >
                <Link2 />
                Clone URL…
                <Check4 on={value === WHERE_CLONE} />
              </CommandItem>
              <CommandItem
                value="action no folder chat"
                data-testid="new-task-where-none"
                onSelect={() => onSelect(WHERE_NONE)}
              >
                <Ban />
                No folder
                <span className="text-[11px] text-muted-foreground">
                  empty scratch directory
                </span>
                <Check4 on={value === WHERE_NONE} />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// --- Task / Chat ---------------------------------------------------------

const MODE_HINTS: Record<DraftMode, string> = {
  task: "Task: its own branch + worktree, tracked on the board through review and merge",
  chat: "Chat: no branch or worktree. With a repository, the agent runs in its checkout, so you can ask questions with the code as context",
};

export function ModeSwitch({
  value,
  onChange,
}: {
  value: DraftMode;
  onChange: (mode: DraftMode) => void;
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Task or chat"
      data-testid="new-task-mode"
      className="mr-1 flex h-7 shrink-0 items-center rounded-lg bg-muted/60 p-0.5"
    >
      {(["task", "chat"] as const).map((mode) => (
        // biome-ignore lint/a11y/useSemanticElements: a two-option segmented control
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          data-testid={`new-task-mode-${mode}`}
          data-selected={value === mode}
          title={MODE_HINTS[mode]}
          onClick={() => onChange(mode)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-2 text-xs transition-colors",
            value === mode
              ? "bg-primary/20 text-primary shadow-sm ring-1 ring-primary/40"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {mode === "task" ? (
            <GitBranch className="size-3.5" />
          ) : (
            <MessageSquare className="size-3.5" />
          )}
          {mode === "task" ? "Task" : "Chat"}
        </button>
      ))}
    </div>
  );
}

// --- Agent · Model ---------------------------------------------------------

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const THINKING_ORDER: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** `provider/name` -> `name`. */
export function modelName(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

/** The chip label: agent, effective model, and thinking only when it differs from the default. */
export function agentModelLabel(
  catalog: HarnessModelCatalog | undefined,
  model: string,
  thinking: ThinkingLevel | "",
): string {
  const parts = [catalog?.label ?? "Pi"];
  const effective = model || catalog?.defaultModel;
  if (effective) parts.push(modelName(effective));
  if (thinking && thinking !== catalog?.defaultThinking) {
    parts.push(THINKING_LABELS[thinking].toLowerCase());
  }
  return parts.join(" · ");
}

export function AgentModelPicker({
  catalogs,
  harness,
  model,
  thinking,
  open,
  onOpenChange,
  onChange,
}: {
  catalogs: readonly HarnessModelCatalog[];
  harness: string;
  model: string;
  thinking: ThinkingLevel | "";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: {
    harness?: string;
    model?: string;
    thinking?: ThinkingLevel | "";
  }) => void;
}): JSX.Element {
  const catalog =
    catalogs.find((entry) => entry.harness === harness) ?? catalogs[0];
  const effective = model || catalog?.defaultModel;
  const effectiveModel = catalog?.models.find(
    (entry) => entry.id === effective,
  );
  // Unknown model (no catalog yet / CLI missing): still offer thinking.
  const supportsThinking = effectiveModel ? effectiveModel.thinking : true;
  const value = `${catalog?.harness ?? harness}\u0000${model}`;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <InputGroupButton
          data-testid="new-task-model"
          aria-label="Agent and model"
          title={`Agent and model (${modKeyLabel()}\u21E7M)`}
          className="min-w-0 max-w-[240px] shrink text-muted-foreground hover:text-foreground"
        >
          <Bot />
          <span className="truncate">
            {agentModelLabel(catalog, model, thinking)}
          </span>
          <ChevronDown className="opacity-60" />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[420px] w-72"
        data-testid="new-task-model-menu"
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const [nextHarness = "", nextModel = ""] = next.split("\u0000");
            onChange({ harness: nextHarness, model: nextModel });
          }}
        >
          {catalogs.map((entry, index) => {
            const providers = [
              ...new Set(entry.models.map((item) => item.provider)),
            ];
            return (
              <div key={entry.harness}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{entry.label}</DropdownMenuLabel>
                <DropdownMenuRadioItem
                  value={`${entry.harness}\u0000`}
                  data-testid="new-task-model-option"
                  data-model=""
                >
                  Default
                  {entry.defaultModel && (
                    <span className="truncate text-muted-foreground">
                      {modelName(entry.defaultModel)}
                    </span>
                  )}
                </DropdownMenuRadioItem>
                {providers.map((provider) => (
                  <div key={provider}>
                    <DropdownMenuLabel className="pl-7 text-[10px] uppercase tracking-wide">
                      {provider}
                    </DropdownMenuLabel>
                    {entry.models
                      .filter((item) => item.provider === provider)
                      .map((item) => (
                        <DropdownMenuRadioItem
                          key={item.id}
                          value={`${entry.harness}\u0000${item.id}`}
                          data-testid="new-task-model-option"
                          data-model={item.id}
                        >
                          <span className="truncate">{item.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                  </div>
                ))}
                {entry.error && (
                  <p className="px-2 py-1 text-[11px] text-amber-300/90">
                    {entry.error}
                  </p>
                )}
              </div>
            );
          })}
        </DropdownMenuRadioGroup>
        {supportsThinking && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="new-task-thinking">
                Thinking
                <span className="ml-auto text-muted-foreground">
                  {thinking
                    ? THINKING_LABELS[thinking]
                    : `Default${catalog?.defaultThinking ? ` (${THINKING_LABELS[catalog.defaultThinking]})` : ""}`}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                <DropdownMenuRadioGroup
                  value={thinking}
                  onValueChange={(next) =>
                    onChange({ thinking: next as ThinkingLevel | "" })
                  }
                >
                  <DropdownMenuRadioItem
                    value=""
                    data-testid="new-task-thinking-option"
                    data-thinking=""
                  >
                    Default
                    {catalog?.defaultThinking && (
                      <span className="text-muted-foreground">
                        {THINKING_LABELS[catalog.defaultThinking]}
                      </span>
                    )}
                  </DropdownMenuRadioItem>
                  {THINKING_ORDER.map((level) => (
                    <DropdownMenuRadioItem
                      key={level}
                      value={level}
                      data-testid="new-task-thinking-option"
                      data-thinking={level}
                    >
                      {THINKING_LABELS[level]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Parent ----------------------------------------------------------------

export function ParentPicker({
  tasks,
  suggested,
  open,
  onOpenChange,
  onSelect,
}: {
  /** Candidate parents: active tasks that are not themselves children. */
  tasks: readonly Task[];
  suggested: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (taskId: string) => void;
}): JSX.Element {
  const rest = tasks.filter((task) => task.id !== suggested?.id);
  const item = (task: Task): JSX.Element => (
    <CommandItem
      key={task.id}
      value={`${task.title} ${task.id}`}
      data-testid="new-task-parent-option"
      data-task-id={task.id}
      onSelect={() => onSelect(task.id)}
    >
      <CornerDownRight />
      <span className="truncate">{task.title}</span>
      {task.repositoryId && (
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {shortName(task.repositoryId)}
        </span>
      )}
    </CommandItem>
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <InputGroupButton
          data-testid="new-task-parent-add"
          aria-label="Add parent"
          title={`Make it a subtask of… (${modKeyLabel()}\u21E7P)`}
          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
        >
          <Plus />
          Parent
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent className="w-80" data-testid="new-task-parent-menu">
        <Command>
          <CommandInput placeholder="Search tasks…" />
          <CommandList>
            <CommandEmpty>No task found.</CommandEmpty>
            {suggested && (
              <CommandGroup heading="Suggested">{item(suggested)}</CommandGroup>
            )}
            {rest.length > 0 && (
              <CommandGroup heading="Tasks">{rest.map(item)}</CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// --- Base branch -----------------------------------------------------------

export function BranchPicker({
  branches,
  defaultBranch,
  parentBranch,
  value,
  open,
  onOpenChange,
  onSelect,
  children,
}: {
  branches: readonly string[] | null;
  defaultBranch: string;
  parentBranch?: string;
  /** The effective base (explicit or smart default). */
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` = back to the smart default. */
  onSelect: (ref: string | null) => void;
  children: ReactNode;
}): JSX.Element {
  const others = (branches ?? []).filter(
    (branch) => branch !== defaultBranch && branch !== parentBranch,
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80" data-testid="new-task-base-ref-menu">
        <Command>
          <CommandInput placeholder="Search branches…" />
          <CommandList>
            <CommandEmpty>
              {branches === null ? "Loading branches…" : "No branch found."}
            </CommandEmpty>
            <CommandGroup>
              {parentBranch && (
                <CommandItem
                  value={`parent ${parentBranch}`}
                  data-testid="new-task-base-ref-option"
                  data-ref={parentBranch}
                  onSelect={() => onSelect(parentBranch)}
                >
                  <GitBranch />
                  <span className="truncate">{parentBranch}</span>
                  <span className="text-[11px] text-muted-foreground">
                    parent's branch
                  </span>
                  <Check4 on={value === parentBranch} />
                </CommandItem>
              )}
              <CommandItem
                value={`default ${defaultBranch}`}
                data-testid="new-task-base-ref-option"
                data-ref={defaultBranch}
                onSelect={() => onSelect(parentBranch ? defaultBranch : null)}
              >
                <GitBranch />
                <span className="truncate">{defaultBranch}</span>
                <span className="text-[11px] text-muted-foreground">
                  default branch
                </span>
                <Check4 on={value === defaultBranch} />
              </CommandItem>
            </CommandGroup>
            {others.length > 0 && (
              <CommandGroup heading="Branches">
                {others.map((branch) => (
                  <CommandItem
                    key={branch}
                    value={branch}
                    data-testid="new-task-base-ref-option"
                    data-ref={branch}
                    onSelect={() => onSelect(branch)}
                  >
                    <GitBranch />
                    <span className="truncate">{branch}</span>
                    <Check4 on={value === branch} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// --- Submit ----------------------------------------------------------------

export const ACTION_LABELS: Record<SubmitAction, string> = {
  start: "Start",
  background: "Run in background",
  park: "Park in backlog",
};

/** What each submit action does, for the menu and tooltips (mode/parent aware). */
export function actionHint(
  action: SubmitAction,
  context: { mode: DraftMode; hasParent: boolean; hasWorktree: boolean },
): string {
  switch (action) {
    case "start":
      return context.mode === "chat"
        ? "Open the chat now and send the prompt"
        : context.hasWorktree
          ? "Create its branch + worktree, open it, and send the prompt"
          : "Open it now and send the prompt";
    case "background":
      return context.hasParent
        ? "The agent starts on its own, nested under the parent; you stay here"
        : "The agent starts on its own in the sidebar; you stay here";
    case "park":
      return context.hasWorktree
        ? "Save it to the backlog; the branch + worktree are made when you start it"
        : "Save it to the backlog to start later";
  }
}

export function SubmitSplitButton({
  primary,
  alternate,
  submitting,
  blockerFor,
  hintFor,
  onSubmit,
}: {
  primary: SubmitAction;
  alternate: SubmitAction;
  submitting: boolean;
  /** Why an action is unavailable right now, or `null`. */
  blockerFor: (action: SubmitAction) => string | null;
  /** What an action does (see `actionHint`). */
  hintFor: (action: SubmitAction) => string;
  onSubmit: (action: SubmitAction) => void;
}): JSX.Element {
  const mod = modKeyLabel();
  const shortcut = (action: SubmitAction): string | undefined =>
    action === primary
      ? `${mod}\u21B5`
      : action === alternate
        ? `\u2325${mod}\u21B5`
        : undefined;
  const primaryBlocker = blockerFor(primary);
  return (
    <div className="flex items-center">
      <Button
        size="sm"
        data-testid="new-task-submit"
        data-action={primary}
        disabled={submitting || primaryBlocker !== null}
        title={primaryBlocker ?? hintFor(primary)}
        onClick={() => onSubmit(primary)}
        className="h-8 rounded-l-lg rounded-r-none pr-2.5"
      >
        {submitting ? "Working…" : ACTION_LABELS[primary]}
        <Kbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground/80">
          {`${mod}\u21B5`}
        </Kbd>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            data-testid="new-task-submit-menu"
            aria-label="More submit options"
            disabled={submitting}
            className="h-8 rounded-l-none rounded-r-lg border-l border-primary-foreground/20 px-1.5"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {(["start", "background", "park"] as const).map((action) => {
            const blocker = blockerFor(action);
            return (
              <DropdownMenuItem
                key={action}
                data-testid={
                  action === "park"
                    ? "new-task-submit-backlog"
                    : `new-task-submit-${action}`
                }
                disabled={blocker !== null}
                onSelect={() => onSubmit(action)}
                // Disabled rows stay readable: the explanation is the point.
                className="flex-col items-start gap-0.5 data-[disabled]:opacity-100"
              >
                <span
                  className={cn(
                    "flex w-full items-center",
                    blocker && "text-muted-foreground",
                  )}
                >
                  {ACTION_LABELS[action]}
                  {shortcut(action) && (
                    <DropdownMenuShortcut>
                      {shortcut(action)}
                    </DropdownMenuShortcut>
                  )}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {hintFor(action)}
                </span>
                {blocker && (
                  <span
                    data-testid="new-task-submit-blocker"
                    className="text-[11px] leading-snug text-amber-300/90"
                  >
                    {blocker}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
