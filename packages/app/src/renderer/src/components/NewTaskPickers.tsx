// The new-task composer's pickers (see /docs/new-task-composer.md): the
// "Where / How" row of labelled chips under the prompt box (Repository
// (Popover + Command, shadcn's Combobox pattern), Base, Agent, Model,
// Thinking (Dropdown Menus, after the AI Elements Model Selector) and
// Options (permission switch + Parent picker)), the Task / Review / Chat
// switch, and the split submit button. Each picker is controlled
// (`open`/`onOpenChange`) where the composer opens it from a keyboard
// shortcut and hands focus back to the prompt when it closes.

import {
  Ban,
  Check,
  ChevronDown,
  CornerDownRight,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Link2,
  MessageSquare,
  X,
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
import { Chip, ChipValue } from "./ui/chip";
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
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Kbd } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Segmented } from "./ui/segmented";
import {
  SplitButton,
  SplitButtonMain,
  SplitButtonTrigger,
} from "./ui/split-button";

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

/** The Where chip's label: what kind of place the value names. */
export function whereChipLabel(token: WhereToken): string {
  const where = parseWhere(token);
  if (where.kind === "folder") return "Folder";
  if (where.kind === "none") return "Where";
  if (where.kind === "clone") return "Clone";
  return "Repository";
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
        <Chip
          data-testid="new-task-where"
          data-where={value}
          aria-label="Where"
          label={whereChipLabel(value)}
          value={whereLabel(value, options)}
          overflowTitle={`${whereChipLabel(value)}: ${whereLabel(value, options)}`}
          valueClassName={value ? undefined : "text-status-needsYou/90"}
          title={`Where it runs (${modKeyLabel()}P)`}
        >
          <ChevronDown />
        </Chip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        data-testid="new-task-where-menu"
      >
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

// --- Task / Review / Chat ------------------------------------------------

const MODE_HINTS: Record<DraftMode, string> = {
  task: "Task: its own branch + worktree, tracked on the board through review and merge",
  review:
    "Review: paste a pull request; the task checks out its head branch (a reviewer never pushes or opens a PR)",
  chat: "Chat: no branch or worktree. With a repository, the agent runs in its checkout, so you can ask questions with the code as context",
};

const MODE_LABELS: Record<DraftMode, string> = {
  task: "Task",
  review: "Review",
  chat: "Chat",
};

function ModeIcon({ mode }: { mode: DraftMode }): JSX.Element {
  if (mode === "review") return <GitPullRequest className="size-3.5" />;
  if (mode === "chat") return <MessageSquare className="size-3.5" />;
  return <GitBranch className="size-3.5" />;
}

/** Task · Review · Chat: the design system's segmented control. */
export function ModeSwitch({
  value,
  onChange,
}: {
  value: DraftMode;
  onChange: (mode: DraftMode) => void;
}): JSX.Element {
  return (
    <Segmented
      ariaLabel="Task, review or chat"
      testId="new-task-mode"
      size="sm"
      value={value}
      onValueChange={onChange}
      options={(["task", "review", "chat"] as const).map((mode) => ({
        value: mode,
        label: (
          <>
            <ModeIcon mode={mode} />
            {MODE_LABELS[mode]}
          </>
        ),
        title: MODE_HINTS[mode],
        testId: `new-task-mode-${mode}`,
      }))}
    />
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

/** The Model chip's value: the effective model's name, else "Default". */
export function modelChipValue(
  catalog: HarnessModelCatalog | undefined,
  model: string,
): string {
  const effective = model || catalog?.defaultModel;
  return effective ? modelName(effective) : "Default";
}

/** The Thinking chip's value: the pick, else the agent's default level, else "Default". */
export function thinkingChipValue(
  catalog: HarnessModelCatalog | undefined,
  thinking: ThinkingLevel | "",
): string {
  const effective = thinking || catalog?.defaultThinking;
  return effective ? THINKING_LABELS[effective] : "Default";
}

/** Whether the effective model takes a thinking level (unknown model: offer it). */
export function supportsThinking(
  catalog: HarnessModelCatalog | undefined,
  model: string,
): boolean {
  const effective = model || catalog?.defaultModel;
  const entry = catalog?.models.find((item) => item.id === effective);
  return entry ? entry.thinking : true;
}

/**
 * The agent (harness) dropdown next to the model picker (decision R8):
 * `Default (<agent>)` follows the repository / app default; any other entry
 * pins the task to that agent. Choosing one resets the model to that
 * agent's default.
 */
export function AgentPicker({
  catalogs,
  harness,
  defaultHarness,
  onChange,
}: {
  catalogs: readonly HarnessModelCatalog[];
  /** The draft's explicit choice; "" = the default agent. */
  harness: string;
  /** The agent "" resolves to (repository override, else app default). */
  defaultHarness: string;
  onChange: (harness: string) => void;
}): JSX.Element {
  const effective = harness || defaultHarness;
  const labelOf = (id: string): string =>
    catalogs.find((entry) => entry.harness === id)?.label ?? id;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip
          data-testid="new-task-agent"
          data-harness={effective}
          aria-label="Agent"
          label="Agent"
          value={labelOf(effective)}
          overflowTitle={`Agent: ${labelOf(effective)}`}
          title="Agent: which coding agent runs this task"
        >
          <ChevronDown />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56"
        data-testid="new-task-agent-menu"
      >
        <DropdownMenuRadioGroup value={harness} onValueChange={onChange}>
          <DropdownMenuRadioItem
            value=""
            data-testid="new-task-agent-option"
            data-harness=""
          >
            Default
            <span className="truncate text-muted-foreground">
              {labelOf(defaultHarness)}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {catalogs.map((entry) => (
            <DropdownMenuRadioItem
              key={entry.harness}
              value={entry.harness}
              data-testid="new-task-agent-option"
              data-harness={entry.harness}
            >
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentModelPicker({
  catalogs,
  harness,
  model,
  loadError,
  open,
  onOpenChange,
  onChange,
}: {
  /** Why the catalogs could not be loaded (shown in place of the model list). */
  loadError?: string | null;
  catalogs: readonly HarnessModelCatalog[];
  harness: string;
  model: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: { harness?: string; model?: string }) => void;
}): JSX.Element {
  const catalog =
    catalogs.find((entry) => entry.harness === harness) ?? catalogs[0];
  // The agent is chosen in its own dropdown; this one lists its models.
  const shown = catalog ? [catalog] : [];
  const value = `${catalog?.harness ?? harness}\u0000${model}`;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Chip
          data-testid="new-task-model"
          data-model={model}
          aria-label="Model"
          label="Model"
          value={modelChipValue(catalog, model)}
          overflowTitle={`Model: ${modelChipValue(catalog, model)}`}
          title={`Model (${modKeyLabel()}\u21E7M)`}
        >
          <ChevronDown />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[420px] w-72"
        data-testid="new-task-model-menu"
      >
        {catalogs.length === 0 && (
          <p
            data-testid="new-task-model-status"
            className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground"
          >
            {loadError ? (
              <span className="text-status-needsYou/90">
                Couldn't load models: {loadError}. If the app was just updated,
                restart it.
              </span>
            ) : (
              "Loading models\u2026"
            )}
          </p>
        )}
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const [nextHarness = "", nextModel = ""] = next.split("\u0000");
            onChange({ harness: nextHarness, model: nextModel });
          }}
        >
          {shown.map((entry, index) => {
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
                  <p className="px-2 py-1 text-[11px] text-status-needsYou/90">
                    {entry.error}
                  </p>
                )}
              </div>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Thinking chip: the effective model's reasoning level (only shown when it takes one). */
export function ThinkingPicker({
  catalog,
  thinking,
  onChange,
}: {
  catalog: HarnessModelCatalog | undefined;
  thinking: ThinkingLevel | "";
  onChange: (thinking: ThinkingLevel | "") => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip
          data-testid="new-task-thinking"
          data-thinking={thinking}
          aria-label="Thinking"
          label="Thinking"
          value={thinkingChipValue(catalog, thinking)}
          overflowTitle={`Thinking: ${thinkingChipValue(catalog, thinking)}`}
          title="Thinking: how hard the model reasons"
        >
          <ChevronDown />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-44"
        data-testid="new-task-thinking-menu"
      >
        <DropdownMenuRadioGroup
          value={thinking}
          onValueChange={(next) => onChange(next as ThinkingLevel | "")}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Options (permission prompts, parent) ---------------------------------

/** The Parent picker's searchable task list (inside the Options popover). */
function ParentCommand({
  tasks,
  suggested,
  onSelect,
}: {
  /** Candidate parents: active tasks that are not themselves children. */
  tasks: readonly Task[];
  suggested: Task | null;
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
    <Command data-testid="new-task-parent-menu">
      <CommandInput autoFocus placeholder="Search tasks…" />
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
  );
}

/** What the Options chip says after its label: only what differs from the default. */
export function optionsSummary(options: {
  parent: Pick<Task, "title"> | null;
  bypass: boolean;
  defaultBypass: boolean;
}): string[] {
  return [
    ...(options.parent ? [`parent: ${options.parent.title}`] : []),
    ...(options.bypass !== options.defaultBypass
      ? [`skip prompts: ${options.bypass ? "on" : "off"}`]
      : []),
  ];
}

export type OptionsView = "main" | "parent";

/**
 * The Options chip (advanced, rarely changed): "Skip permission prompts"
 * (decision R7: whether a *Run in background* launch skips the agent's
 * permission prompts; starts on the repository / app default, never
 * sticky; Start & open never bypasses) and "Parent task" (the searchable
 * task picker, one level only). The chip's label lists the values that
 * differ from the default, e.g. `Options · parent: Fix MEV`.
 */
export function OptionsPicker({
  open,
  view,
  onOpenChange,
  onViewChange,
  bypass,
  defaultBypass,
  onBypassChange,
  parent,
  parentCandidates,
  suggestedParent,
  onParentChange,
}: {
  open: boolean;
  view: OptionsView;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: OptionsView) => void;
  bypass: boolean;
  /** The repository / app default (`bypassPermissions`). */
  defaultBypass: boolean;
  onBypassChange: (next: boolean) => void;
  parent: Task | null;
  parentCandidates: readonly Task[];
  suggestedParent: Task | null;
  /** `null` = standalone again. */
  onParentChange: (taskId: string | null) => void;
}): JSX.Element {
  const summary = optionsSummary({ parent, bypass, defaultBypass });
  const mod = modKeyLabel();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Chip
          data-testid="new-task-options"
          data-bypass={bypass ? "true" : "false"}
          aria-label="Options"
          label="Options"
          title={
            summary.length
              ? `Options: ${summary.join(", ")}`
              : `Options: permission prompts, parent task (${mod}\u21E7P)`
          }
          className="border-dashed"
        >
          {parent && (
            <ChipValue data-testid="new-task-parent" data-value={parent.id}>
              {`\u00B7 parent: ${parent.title}`}
            </ChipValue>
          )}
          {bypass !== defaultBypass && (
            <ChipValue data-testid="new-task-options-bypass">
              {`\u00B7 skip prompts: ${bypass ? "on" : "off"}`}
            </ChipValue>
          )}
          <ChevronDown />
        </Chip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("p-0", view === "parent" ? "w-80" : "w-72")}
        data-testid="new-task-options-menu"
      >
        {view === "parent" ? (
          <ParentCommand
            tasks={parentCandidates}
            suggested={suggestedParent}
            onSelect={(taskId) => onParentChange(taskId)}
          />
        ) : (
          <div className="flex flex-col gap-1 p-1.5 text-xs">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-accent/40">
              <button
                type="button"
                role="switch"
                aria-checked={bypass}
                data-testid="new-task-bypass"
                data-bypass={bypass ? "true" : "false"}
                aria-label="Skip permission prompts"
                onClick={() => onBypassChange(!bypass)}
                className={cn(
                  "relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                  bypass ? "bg-primary" : "bg-muted-foreground/40",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-3 rounded-full bg-background shadow transition-transform",
                    bypass ? "translate-x-3.5" : "translate-x-0.5",
                  )}
                />
              </button>
              <span className="flex flex-col gap-0.5">
                <span className="text-foreground">Skip permission prompts</span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  Run in background only (Claude Code's
                  --dangerously-skip-permissions). Start &amp; open keeps your
                  own settings.
                  {bypass === defaultBypass ? " Default from settings." : ""}
                </span>
              </span>
            </label>
            <div className="flex items-center gap-2 rounded-md p-1.5">
              <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-foreground">Parent task</span>
              {parent ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {parent.title}
                  </span>
                  <button
                    type="button"
                    data-testid="new-task-parent-remove"
                    aria-label="Remove parent"
                    title="Remove parent"
                    onClick={() => onParentChange(null)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="new-task-parent-add"
                  title={`Make it a subtask of… (${mod}\u21E7P)`}
                  onClick={() => onViewChange("parent")}
                  className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Choose…
                </button>
              )}
            </div>
          </div>
        )}
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
  describedBy,
  onSubmit,
}: {
  /** Id of the inline note naming what the primary action still needs. */
  describedBy?: string;
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
    <SplitButton variant="default" size="sm">
      <SplitButtonMain
        data-testid="new-task-submit"
        data-action={primary}
        disabled={submitting || primaryBlocker !== null}
        title={
          primaryBlocker
            ? `${primaryBlocker} to ${ACTION_LABELS[primary].toLowerCase()}`
            : hintFor(primary)
        }
        aria-describedby={primaryBlocker ? describedBy : undefined}
        onClick={() => onSubmit(primary)}
      >
        {submitting ? "Working…" : ACTION_LABELS[primary]}
        <Kbd>{`${mod}\u21B5`}</Kbd>
      </SplitButtonMain>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SplitButtonTrigger
            data-testid="new-task-submit-menu"
            aria-label="More submit options"
            disabled={submitting}
          />
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
                    className="text-[11px] leading-snug text-status-needsYou/90"
                  >
                    {blocker}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SplitButton>
  );
}
