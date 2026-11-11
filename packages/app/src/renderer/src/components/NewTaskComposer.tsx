import { CornerDownRight, GitBranch, X } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HarnessModelCatalog,
  KnownLocation,
  LaunchSettings,
  RepositoryInfo,
  Task,
} from "../../../preload/api";
import { shellEscapePaths } from "../../../shared/shell-escape";
import {
  alternateAction,
  defaultAction,
  deriveTitle,
  effectiveBaseRef,
  effectiveTitle,
  folderWhere,
  type NewTaskDraft,
  parseWhere,
  planSubmit,
  previewSlug,
  repoWhere,
  type SubmitAction,
  submitBlocker,
  WHERE_CLONE,
  type WhereToken,
} from "../lib/new-task-draft";
import {
  ACTION_LABELS,
  AgentModelPicker,
  AgentPicker,
  actionHint,
  BranchPicker,
  BypassPermissionsSwitch,
  ModeSwitch,
  ParentPicker,
  SubmitSplitButton,
  WherePicker,
  whereLabel,
  whereOptions,
} from "./NewTaskPickers";
import { PullRequestField, useParsedPullRequest } from "./PullRequestField";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "./ui/input-group";

/** What the composer reports once a submit succeeded; App.tsx clears the draft and routes focus. */
export interface NewTaskOutcome {
  action: SubmitAction;
  task: Task;
}

/** A clipboard image the paste resolver saved to a temp file (`main/clipboard-paste.ts`'s naming). */
const PASTED_IMAGE =
  /(^|\/)clipboard-\d{4}-\d{2}-\d{2}-\d{6}-[0-9A-F]{8}\.png$/;

type PickerId = "where" | "model" | "parent" | "branch";

/**
 * The new-task DRAFT page (see /docs/new-task-composer.md): a centered
 * column with the big `Untitled task` title, then one composer card (the
 * shadcn Input Group the AI Elements Prompt Input is built on): an
 * optional context tray (parent pill, clone URL), the prompt, and a
 * toolbar with Where · Agent·Model · + Parent and the split submit button.
 * The muted line under the card previews the branch and its base.
 *
 * The draft is renderer-only state owned by App.tsx (persisted to
 * localStorage, lib/new-task-draft.ts): core never sees an unsubmitted task.
 * This component is controlled (`draft` + `onChange`) and talks to core only
 * through `window.harbormaster.core`. Which core command a submit maps to is
 * `planSubmit`'s call (pure, unit-tested).
 *
 * Run in background queues a session and never steals focus: App.tsx returns
 * focus to the origin task and a toast is the only acknowledgement. Thrown
 * errors surface inline; the draft stays so the user can fix the input.
 */
export function NewTaskComposer({
  draft,
  onChange,
  origin,
  tasks,
  recents,
  focusSignal,
  onSubmitted,
}: {
  draft: NewTaskDraft;
  onChange: (patch: Partial<NewTaskDraft>) => void;
  /** The task focused when the draft was opened (first parent suggestion), if it still exists. */
  origin: Task | null;
  /** Every board task, for the parent picker. */
  tasks: readonly Task[];
  /** Recently used Where tokens, most recent first. */
  recents: readonly WhereToken[];
  /** Bumped when the draft is re-focused (Cmd/Ctrl+N while already open). */
  focusSignal: number;
  onSubmitted: (outcome: NewTaskOutcome) => void;
}): JSX.Element {
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [locations, setLocations] = useState<KnownLocation[]>([]);
  const [catalogs, setCatalogs] = useState<HarnessModelCatalog[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  /** Load (or retry) the model catalogs; a failure is shown in the picker, never thrown. */
  const loadModels = useCallback((): void => {
    setModelsError(null);
    void window.harbormaster.core
      .listModels()
      .then((next) => {
        setCatalogs(next);
        if (next.length === 0) setModelsError("No agent reported any models");
      })
      .catch((thrown: unknown) =>
        setModelsError(
          thrown instanceof Error ? thrown.message : String(thrown),
        ),
      );
  }, []);
  const [branches, setBranches] = useState<{
    repositoryId: string;
    list: string[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<PickerId | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cloneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const core = window.harbormaster.core;
    void core.listRepositories().then(setRepositories);
    void core.listLocations().then(setLocations);
    loadModels();
  }, [loadModels]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSignal is the trigger
  useEffect(() => {
    promptRef.current?.focus();
  }, [focusSignal]);

  const where = parseWhere(draft.where);
  // Repository-aware defaults: the agent a task gets when none is chosen
  // and whether a background run bypasses permission prompts.
  const settingsRepo = where.kind === "repository" ? where.repositoryId : "";
  const [launchSettings, setLaunchSettings] = useState<Pick<
    LaunchSettings,
    "defaultHarness" | "bypassPermissions"
  > | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core
      .getLaunchSettings(settingsRepo || undefined)
      .then((settings) => {
        if (!cancelled) setLaunchSettings(settings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settingsRepo]);
  // A child inherits its parent's agent (R8); else the repository / app default.
  const parentHarness = draft.parentTaskId
    ? tasks.find((task) => task.id === draft.parentTaskId)?.harness
    : undefined;
  const defaultHarness =
    parentHarness ??
    launchSettings?.defaultHarness ??
    catalogs[0]?.harness ??
    "pi";
  const effectiveHarness = draft.harness || defaultHarness;
  const bypass =
    draft.bypassPermissions ?? launchSettings?.bypassPermissions ?? true;
  const options = useMemo(
    () => whereOptions(repositories, locations),
    [repositories, locations],
  );
  const parent = draft.parentTaskId
    ? (tasks.find((task) => task.id === draft.parentTaskId) ?? null)
    : null;
  // One level only: a task that is itself a child can't be a parent.
  const parentCandidates = useMemo(
    () => tasks.filter((task) => !task.parentTaskId && task.state !== "done"),
    [tasks],
  );
  const suggestedParent =
    origin && !origin.parentTaskId && origin.state !== "done" ? origin : null;

  const selectedRepo =
    where.kind === "repository"
      ? repositories.find((repo) => repo.id === where.repositoryId)
      : undefined;
  const baseRef = effectiveBaseRef(draft, parent);
  const base = baseRef ?? selectedRepo?.defaultBranch;
  const parentBranch =
    parent?.branch && parent.repositoryId === selectedRepo?.id
      ? parent.branch
      : undefined;

  // Branches load lazily, the first time the branch picker opens for a repo.
  useEffect(() => {
    if (openPicker !== "branch" || !selectedRepo) return;
    if (branches?.repositoryId === selectedRepo.id) return;
    const repositoryId = selectedRepo.id;
    void window.harbormaster.core
      .listBranches(repositoryId)
      .then((list) => setBranches({ repositoryId, list }))
      .catch(() => setBranches({ repositoryId, list: [] }));
  }, [openPicker, selectedRepo, branches]);

  const primary = defaultAction(draft);
  const alternate = alternateAction(draft);
  // A PR URL (core parses it): the task binds to that PR in its repository.
  const pullRequest = useParsedPullRequest(draft.prUrl);
  const blockerFor = useCallback(
    (action: SubmitAction) => submitBlocker(draft, action, pullRequest),
    [draft, pullRequest],
  );
  const chat = draft.mode === "chat";
  // Only a task in a repository (or a clone) gets a branch + worktree.
  const hasWorktree =
    !chat && (where.kind === "repository" || where.kind === "clone");
  const hintFor = useCallback(
    (action: SubmitAction) =>
      actionHint(action, {
        mode: draft.mode,
        hasParent: !!draft.parentTaskId,
        hasWorktree,
      }),
    [draft.mode, draft.parentTaskId, hasWorktree],
  );
  const primaryBlocker = blockerFor(primary);

  async function submit(action: SubmitAction): Promise<void> {
    if (submitting || submitBlocker(draft, action, pullRequest)) return;
    setSubmitting(true);
    setError(null);
    try {
      const plan = planSubmit(draft, action, parent, pullRequest ?? null);
      const core = window.harbormaster.core;
      const task =
        plan.command === "launchTask"
          ? await core.launchTask(plan.input)
          : await core.createTask(plan.input);
      onSubmitted({ action, task });
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  function closePicker(): void {
    setOpenPicker(null);
    // After the popover's own focus restore, so the prompt wins.
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  function pickerProps(id: PickerId) {
    return {
      open: openPicker === id,
      onOpenChange: (open: boolean) => {
        if (open) setOpenPicker(id);
        else if (openPicker === id) closePicker();
      },
    };
  }

  function selectWhere(token: WhereToken): void {
    onChange({ where: token, baseRef: null });
    if (token === WHERE_CLONE) {
      setOpenPicker(null);
      requestAnimationFrame(() => cloneRef.current?.focus());
      return;
    }
    closePicker();
  }

  async function openFolder(): Promise<void> {
    setOpenPicker(null);
    const path = await window.harbormaster.app.pickFolder();
    if (!path) {
      promptRef.current?.focus();
      return;
    }
    try {
      const location = await window.harbormaster.core.addLocation(path);
      const [repos, locs] = await Promise.all([
        window.harbormaster.core.listRepositories(),
        window.harbormaster.core.listLocations(),
      ]);
      setRepositories(repos);
      setLocations(locs);
      onChange({
        where: location.repositoryId
          ? repoWhere(location.repositoryId)
          : folderWhere(location.path),
        baseRef: null,
      });
      setError(null);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
    promptRef.current?.focus();
  }

  /** Insert text at the prompt's cursor (replacing the selection), caret after it. */
  function insertAtCursor(text: string): void {
    const element = promptRef.current;
    const value = draft.prompt;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${text}${value.slice(end)}`;
    onChange({ prompt: next });
    const caret = start + pad.length + text.length;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(caret, caret);
    });
  }

  function trackAttachment(text: string): string[] {
    return PASTED_IMAGE.test(text) && !draft.attachments.includes(text)
      ? [...draft.attachments, text]
      : draft.attachments;
  }

  // Paste: files and images go through the same resolver as terminal panes
  // (Finder files -> paths, a clipboard image -> a saved temp PNG's path);
  // plain text keeps the native paste (and its undo).
  async function onPaste(
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> {
    const data = event.clipboardData;
    const hasFiles =
      data.files.length > 0 ||
      Array.from(data.types).some(
        (type) => type === "Files" || type.startsWith("image/"),
      );
    if (!hasFiles) return;
    event.preventDefault();
    const text = await window.harbormaster.terminalHost.resolveClipboardPaste();
    if (!text) return;
    const attachments = trackAttachment(text);
    insertAtCursor(text);
    if (attachments !== draft.attachments) onChange({ attachments });
  }

  function onDrop(event: React.DragEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    const paths = files
      .map((file) => window.harbormaster.terminalHost.getPathForFile(file))
      .filter(Boolean);
    if (paths.length) insertAtCursor(shellEscapePaths(paths));
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (event.key === "Enter") {
      event.preventDefault();
      void submit(event.altKey ? alternate : primary);
    } else if (key === "p" && !event.shiftKey) {
      event.preventDefault();
      setOpenPicker("where");
    } else if (key === "m" && event.shiftKey) {
      event.preventDefault();
      setOpenPicker("model");
    } else if (key === "p" && event.shiftKey) {
      event.preventDefault();
      setOpenPicker("parent");
    }
  }

  const title = effectiveTitle(draft);
  const derived = deriveTitle(draft.prompt);
  const showTray = !!parent || where.kind === "clone";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: composer-wide shortcuts (see onKeyDown)
    <div
      data-testid="new-task-composer"
      className="h-full flex-1 overflow-y-auto bg-background"
      onKeyDown={onKeyDown}
    >
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 px-6 pb-12 pt-[16vh]">
        <input
          data-testid="new-task-title-input"
          aria-label="Title"
          value={draft.title}
          onChange={(event) => onChange({ title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              promptRef.current?.focus();
            }
          }}
          placeholder={derived || "Untitled task"}
          className="w-full border-0 bg-transparent px-1 text-3xl font-semibold tracking-tight text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none"
        />
        <InputGroup>
          {showTray && (
            <InputGroupAddon
              align="block-start"
              className="flex-wrap gap-2 border-b border-border/60 pb-2.5 pt-2.5"
            >
              {parent && (
                <span
                  data-testid="new-task-parent"
                  data-value={parent.id}
                  className="flex h-6 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/60 pl-2 pr-1 text-xs text-foreground"
                >
                  <CornerDownRight className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">subtask of</span>
                  <span className="max-w-[260px] truncate">{parent.title}</span>
                  <button
                    type="button"
                    data-testid="new-task-parent-remove"
                    aria-label="Remove parent"
                    title="Remove parent"
                    onClick={() =>
                      onChange({ parentTaskId: null, baseRef: null })
                    }
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              )}
              {where.kind === "clone" && (
                <input
                  ref={cloneRef}
                  data-testid="new-task-clone-url-input"
                  aria-label="Clone URL"
                  value={draft.cloneUrl}
                  onChange={(event) =>
                    onChange({ cloneUrl: event.target.value })
                  }
                  placeholder="https://github.com/org/repo.git"
                  className="h-6 min-w-[260px] flex-1 rounded-md border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              )}
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            ref={promptRef}
            autoFocus
            data-testid="new-task-prompt-input"
            aria-label="Prompt"
            rows={5}
            value={draft.prompt}
            onChange={(event) => onChange({ prompt: event.target.value })}
            onPaste={(event) => void onPaste(event)}
            onDrop={onDrop}
            placeholder={
              chat
                ? selectedRepo || where.kind === "folder"
                  ? `Ask anything about ${whereLabel(draft.where, options)}\u2026`
                  : "Ask anything\u2026"
                : "What should the agent do? Paste screenshots or drop files."
            }
            className="min-h-[132px] text-[13px] leading-relaxed"
          />
          <InputGroupAddon align="block-end" className="gap-0.5">
            <ModeSwitch
              value={draft.mode}
              onChange={(mode) => {
                onChange({ mode });
                promptRef.current?.focus();
              }}
            />
            <WherePicker
              value={draft.where}
              options={options}
              recents={recents}
              {...pickerProps("where")}
              onSelect={selectWhere}
              onOpenFolder={() => void openFolder()}
            />
            <AgentPicker
              catalogs={catalogs}
              harness={draft.harness}
              defaultHarness={defaultHarness}
              onChange={(harness) =>
                onChange({ harness, model: "", thinking: "" })
              }
            />
            <AgentModelPicker
              catalogs={catalogs}
              harness={effectiveHarness}
              model={draft.model}
              thinking={draft.thinking}
              loadError={modelsError}
              open={openPicker === "model"}
              onOpenChange={(open) => {
                // Retry a failed/empty load whenever the picker opens.
                if (open && catalogs.length === 0) loadModels();
                pickerProps("model").onOpenChange(open);
              }}
              onChange={(patch) => {
                // The agent is the agent dropdown's call; the model picker
                // only ever shows (and edits) the effective agent's models.
                // A concrete model pins the agent it belongs to.
                const { harness: _ignored, ...rest } = patch;
                onChange(
                  rest.model ? { ...rest, harness: effectiveHarness } : rest,
                );
              }}
            />
            <BypassPermissionsSwitch
              value={bypass}
              onChange={(next) => onChange({ bypassPermissions: next })}
            />
            {!parent && (
              <ParentPicker
                tasks={parentCandidates}
                suggested={suggestedParent}
                {...pickerProps("parent")}
                onSelect={(taskId) => {
                  onChange({ parentTaskId: taskId, baseRef: null });
                  closePicker();
                }}
              />
            )}
            <div className="ml-auto shrink-0 pl-2">
              <SubmitSplitButton
                primary={primary}
                alternate={alternate}
                submitting={submitting}
                blockerFor={blockerFor}
                hintFor={hintFor}
                onSubmit={(action) => void submit(action)}
              />
            </div>
          </InputGroupAddon>
        </InputGroup>
        <div className="flex min-h-5 items-center gap-2 px-1 text-[11px] text-muted-foreground">
          {pullRequest && !chat ? (
            <span data-testid="new-task-where-hint" className="truncate">
              {draft.prRole === "reviewer"
                ? `Reviews ${pullRequest.repositoryId} #${pullRequest.number} on its head branch: never pushes or opens a PR`
                : `Works on ${pullRequest.repositoryId} #${pullRequest.number} on its head branch`}
            </span>
          ) : chat && selectedRepo ? (
            <span
              data-testid="new-task-where-hint"
              className="truncate"
              title={selectedRepo.root}
            >
              Chats in your {whereLabel(draft.where, options)} checkout: no
              branch or worktree, and any edits land directly in it
            </span>
          ) : selectedRepo && base ? (
            <BranchPicker
              branches={
                branches?.repositoryId === selectedRepo.id
                  ? branches.list
                  : null
              }
              defaultBranch={selectedRepo.defaultBranch}
              {...(parentBranch ? { parentBranch } : {})}
              value={base}
              {...pickerProps("branch")}
              onSelect={(ref) => {
                onChange({ baseRef: ref });
                closePicker();
              }}
            >
              <button
                type="button"
                data-testid="new-task-branch-preview"
                title="Change the base branch"
                className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 font-mono hover:bg-accent/60 hover:text-foreground"
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">
                  {`${previewSlug(title || "task")}-\u2026`}
                </span>
                <span className="shrink-0 opacity-60">{"\u2190"}</span>
                <span data-testid="new-task-base-ref" className="truncate">
                  {base}
                </span>
              </button>
            </BranchPicker>
          ) : where.kind === "folder" ? (
            <span data-testid="new-task-where-hint" className="truncate">
              Runs in place in {where.path}: no branch or worktree
            </span>
          ) : where.kind === "none" ? (
            <span data-testid="new-task-where-hint">
              No folder: the agent starts in an empty scratch directory
            </span>
          ) : where.kind === "clone" ? (
            <span data-testid="new-task-where-hint">
              {chat
                ? "Cloned under your code root; the chat runs in the clone"
                : "Cloned under your code root, then a new branch + worktree"}
            </span>
          ) : null}
          {error ? (
            <span
              className="ml-auto text-red-400"
              data-testid="new-task-error"
              role="alert"
            >
              {error}
            </span>
          ) : (
            primaryBlocker && (
              <span
                data-testid="new-task-blocker"
                className="ml-auto shrink-0 text-amber-300/80"
              >
                {primaryBlocker} to {ACTION_LABELS[primary].toLowerCase()}
              </span>
            )
          )}
        </div>
        <PullRequestField
          url={draft.prUrl}
          role={draft.prRole}
          parsed={pullRequest}
          onChange={(patch) => onChange(patch)}
        />
      </div>
    </div>
  );
}
