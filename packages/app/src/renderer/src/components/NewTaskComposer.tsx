import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type {
  LaunchTaskInput,
  RepositoryInfo,
  Task,
} from "../../../preload/api";
import {
  CLONE_URL_VALUE,
  effectiveTitle,
  type NewTaskDraft,
  previewSlug,
  SCRATCH_VALUE,
} from "../lib/new-task-draft";
import { modKeyLabel } from "../lib/platform";
import { repositoryLabel } from "../lib/repository-label";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/** What the composer reports once a submit succeeded; App.tsx clears the draft and routes focus. */
export type NewTaskOutcome =
  | { kind: "start"; task: Task }
  | { kind: "backlog"; task: Task }
  | { kind: "launch"; task: Task };

const CHIP =
  "h-7 rounded-full border border-border bg-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * The new-task DRAFT page: a flat composer (no overlay, no card) that fills
 * the workspace main pane while the sidebar's draft row is focused.
 * Replaces the old floating "+ New task" modal; Cmd/Ctrl+N, the sidebar
 * button and the board header button all open THE draft (App.tsx).
 *
 * The draft is renderer-only state owned by App.tsx (persisted to
 * localStorage, lib/new-task-draft.ts): core never sees an unsubmitted
 * task. This component is controlled (`draft` + `onChange`) and talks to
 * core only through `window.harbormaster.core`.
 *
 * Title is optional (effective title = typed title, else the first line of
 * the prompt). Without a link the footer offers "Park in backlog" and
 * "Start" (lands in Dev, worktree created now). Linking the draft to its
 * ORIGIN task (the task focused when the draft was opened) switches to
 * launch mode, per /docs/design-decisions.md "Launching tasks from an agent": relation `child` (Subtask) or
 * `standalone`, prompt required, Clone URL / base-branch / model options
 * appear, and submit calls `core.launchTask` directly.
 *
 * Launching queues a background session and NEVER steals focus/view (the
 * PRD's "launching never steals focus"): App.tsx returns focus to the origin
 * task and a toast is the only acknowledgement. Thrown errors surface inline
 * (the draft stays so the user can fix the input).
 */
export function NewTaskComposer({
  draft,
  onChange,
  origin,
  focusSignal,
  onSubmitted,
}: {
  draft: NewTaskDraft;
  onChange: (patch: Partial<NewTaskDraft>) => void;
  /** The draft's origin task, if it still exists; `null` = no link chip. */
  origin: Task | null;
  /** Bumped when the draft is re-focused (Cmd/Ctrl+N while already open). */
  focusSignal: number;
  onSubmitted: (outcome: NewTaskOutcome) => void;
}): JSX.Element {
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(
    undefined,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.harbormaster.core.listRepositories().then(setRepositories);
    void window.harbormaster.core
      .getLaunchSettings()
      .then((settings) => setDefaultModel(settings.defaultModel));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSignal is the trigger
  useEffect(() => {
    promptRef.current?.focus();
  }, [focusSignal]);

  const link = origin ? draft.link : "none";
  const launching = link !== "none";
  // One level only (see /docs/design-decisions.md "Launching tasks from an agent"): a task that is itself a
  // child can never launch further children, only standalone tasks.
  const canLaunchChild = !!origin && !origin.parentTaskId;
  // "parent" base branch only ever applies to a child launched into the
  // parent's own repository, and only once the parent has a branch (a
  // parked backlog task has none yet) — see CoreCommands.launchTask's
  // rejection rule.
  const baseBranchEligible =
    link === "child" &&
    !!origin?.branch &&
    !!origin?.repositoryId &&
    draft.repositoryId === origin.repositoryId;
  const baseBranch = baseBranchEligible ? draft.baseBranch : "default";

  const title = effectiveTitle(draft);
  const cloneMissing =
    draft.repositoryId === CLONE_URL_VALUE && !draft.cloneUrl.trim();
  const canSubmit =
    !submitting &&
    title.length > 0 &&
    (!launching || (draft.prompt.trim().length > 0 && !cloneMissing));

  async function submit(kind: "start" | "backlog" | "launch"): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const core = window.harbormaster.core;
      if (kind === "launch") {
        if (!origin || link === "none") return;
        const repository: LaunchTaskInput["repository"] =
          draft.repositoryId === SCRATCH_VALUE
            ? { none: true }
            : draft.repositoryId === CLONE_URL_VALUE
              ? { cloneUrl: draft.cloneUrl.trim() }
              : { repositoryId: draft.repositoryId };
        const task = await core.launchTask({
          relation: link,
          fromTaskId: origin.id,
          title,
          prompt: draft.prompt.trim(),
          repository,
          ...(baseBranchEligible && baseBranch === "parent"
            ? { baseBranch: "parent" as const }
            : {}),
          ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        });
        onSubmitted({ kind, task });
        return;
      }
      const task = await core.createTask({
        title,
        initialPrompt: draft.prompt.trim() ? draft.prompt : "",
        ...(draft.repositoryId && draft.repositoryId !== CLONE_URL_VALUE
          ? { repositoryId: draft.repositoryId }
          : {}),
        ...(kind === "start" ? { start: true } : {}),
      });
      onSubmitted({ kind, task });
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  const primary = launching ? "launch" : "start";
  function onSubmitKey(event: React.KeyboardEvent): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(primary);
    }
  }

  const selectedRepo = repositories.find(
    (repo) => repo.id === draft.repositoryId,
  );
  const branchPreview =
    selectedRepo && title
      ? `${previewSlug(title)}-\u2026 \u2192 ${selectedRepo.defaultBranch}`
      : undefined;

  return (
    <div
      data-testid="new-task-composer"
      className="h-full flex-1 overflow-y-auto bg-background"
    >
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 pb-12 pt-24">
        <input
          data-testid="new-task-title-input"
          aria-label="Title"
          value={draft.title}
          onChange={(event) => onChange({ title: event.target.value })}
          onKeyDown={(event) => {
            onSubmitKey(event);
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              promptRef.current?.focus();
            }
          }}
          placeholder="Untitled task"
          className="w-full border-0 bg-transparent text-2xl font-semibold text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none"
        />
        <textarea
          ref={promptRef}
          // biome-ignore lint/a11y/noAutofocus: the composer's whole purpose is typing the prompt
          autoFocus
          data-testid="new-task-prompt-input"
          aria-label="Prompt"
          rows={6}
          value={draft.prompt}
          onChange={(event) => onChange({ prompt: event.target.value })}
          onKeyDown={onSubmitKey}
          placeholder="What should pi do?"
          className="min-h-[140px] w-full resize-y rounded-lg border border-border/70 bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="new-task-repo-select"
            aria-label="Repository"
            className={CHIP}
            value={draft.repositoryId}
            onChange={(event) => onChange({ repositoryId: event.target.value })}
          >
            <option value={SCRATCH_VALUE}>None / scratch</option>
            {repositories.map((repo) => (
              <option
                key={repo.id}
                value={repo.id}
                data-testid="new-task-repo-option"
              >
                {repositoryLabel(repo)}
              </option>
            ))}
            {launching && <option value={CLONE_URL_VALUE}>Clone URL…</option>}
          </select>
          {baseBranchEligible && origin && (
            <fieldset
              data-testid="new-task-base-branch"
              className={cn(CHIP, "flex items-center gap-1 p-0.5")}
            >
              <legend className="sr-only">Base branch</legend>
              {(
                [
                  [
                    "default",
                    "Default branch",
                    "The repository's default branch",
                  ],
                  ["parent", "Parent's branch", `Stack on "${origin.branch}"`],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  title={hint}
                  data-testid={`new-task-base-branch-${value}`}
                  data-selected={baseBranch === value}
                  onClick={() => onChange({ baseBranch: value })}
                  className={cn(
                    "rounded-full px-2 py-0.5",
                    baseBranch === value
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          )}
          {origin && link === "none" && (
            <button
              type="button"
              data-testid="new-task-link-add"
              title="Launch this from the task you were on, in the background"
              onClick={() => onChange({ link: "standalone" })}
              className={cn(CHIP, "max-w-[260px] truncate")}
            >
              ↳ Link to {origin.title}
            </button>
          )}
          {origin && link !== "none" && (
            <fieldset
              data-testid="new-task-link"
              className={cn(
                CHIP,
                "flex max-w-full items-center gap-1 p-0.5 pl-2.5",
              )}
            >
              <legend className="sr-only">Link</legend>
              <span className="max-w-[200px] truncate">
                ↳ from: {origin.title}
              </span>
              {(
                [
                  [
                    "child",
                    "Subtask",
                    canLaunchChild
                      ? "Launch a child task: nested under this one, pollable"
                      : "A child task cannot launch further children (one level only)",
                  ],
                  [
                    "standalone",
                    "Standalone",
                    "Launch a standalone task: no lineage, no polling",
                  ],
                ] as const
              ).map(([value, label, hint]) => {
                const disabled = value === "child" && !canLaunchChild;
                return (
                  <button
                    key={value}
                    type="button"
                    title={hint}
                    disabled={disabled}
                    data-testid={`new-task-link-${value}`}
                    data-selected={link === value}
                    onClick={() => onChange({ link: value })}
                    className={cn(
                      "rounded-full px-2 py-0.5",
                      disabled && "cursor-not-allowed opacity-50",
                      link === value
                        ? "bg-primary text-primary-foreground"
                        : !disabled && "hover:bg-muted",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
              <button
                type="button"
                data-testid="new-task-link-none"
                aria-label="Remove link"
                title="Remove link"
                onClick={() => onChange({ link: "none" })}
                className="rounded-full px-1.5 py-0.5 hover:bg-muted"
              >
                ×
              </button>
            </fieldset>
          )}
          {launching && (
            <input
              data-testid="new-task-model-input"
              aria-label="Model"
              value={draft.model}
              onChange={(event) => onChange({ model: event.target.value })}
              placeholder={defaultModel ?? "harness default"}
              className={cn(CHIP, "w-44 placeholder:text-muted-foreground/70")}
            />
          )}
        </div>
        {launching && draft.repositoryId === CLONE_URL_VALUE && (
          <input
            data-testid="new-task-clone-url-input"
            aria-label="Clone URL"
            value={draft.cloneUrl}
            onChange={(event) => onChange({ cloneUrl: event.target.value })}
            placeholder="https://github.com/org/repo.git"
            className="h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        )}
        {branchPreview && (
          <p
            className="font-mono text-[11px] text-muted-foreground"
            data-testid="new-task-branch-preview"
          >
            {branchPreview}
          </p>
        )}
        {error && (
          <p
            className="text-xs text-red-400"
            data-testid="new-task-error"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {launching && origin && (
            <span className="mr-auto truncate text-[11px] text-muted-foreground">
              Runs in the background — focus returns to {origin.title}
            </span>
          )}
          {!launching && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="new-task-submit-backlog"
              disabled={!canSubmit}
              title="No branch or worktree yet"
              onClick={() => void submit("backlog")}
            >
              Park in backlog
            </Button>
          )}
          <Button
            size="sm"
            data-testid="new-task-submit"
            disabled={!canSubmit}
            onClick={() => void submit(primary)}
          >
            {launching
              ? submitting
                ? "Launching…"
                : link === "child"
                  ? "Launch subtask"
                  : "Launch task"
              : "Start"}
            {!launching && <Kbd>{`${modKeyLabel()}\u21B5`}</Kbd>}
          </Button>
        </div>
      </div>
    </div>
  );
}
