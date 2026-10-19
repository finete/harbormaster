import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  LaunchTaskInput,
  RepositoryInfo,
  Task,
} from "../../../preload/api";
import { repositoryLabel } from "../lib/repository-label";
import { cn } from "../lib/utils";
import { pushToast } from "../toast";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const SCRATCH_VALUE = "__none__";
const CLONE_URL_VALUE = "__clone-url__";

export type LaunchRelation = "child" | "standalone";

/**
 * "Launch subtask… / Launch task…" (see ai/prds/task-launching.md and the
 * wave-3 task brief item 5): the one `launchTask` entry point in the UI,
 * reachable from the task workspace header (TaskActions.tsx). Both menu
 * items open the exact same dialog with `relation` preselected (subtask =
 * `child`, task = `standalone`); the picker inside stays switchable, so a
 * user who opened "Launch subtask…" can still back out to a standalone
 * launch without reopening anything.
 *
 * Submitting calls `launchTask` and closes immediately: launching queues a
 * background session and NEVER switches view or focus to the new task (see
 * the PRD's "launching never steals focus") — a toast is the only
 * acknowledgement. Thrown errors surface inline instead (the dialog stays
 * open so the user can fix the input), matching `NewTaskDialog`'s pattern
 * everywhere else it applies.
 */
export function LaunchTaskDialog({
  open,
  onOpenChange,
  fromTask,
  defaultRelation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task this launch originates from (TaskActions always has one open task in view). */
  fromTask: Task;
  defaultRelation: LaunchRelation;
}): JSX.Element {
  const [relation, setRelation] = useState<LaunchRelation>(defaultRelation);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repositoryChoice, setRepositoryChoice] = useState(SCRATCH_VALUE);
  const [cloneUrl, setCloneUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState<"default" | "parent">("default");
  const [model, setModel] = useState("");
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(
    undefined,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRelation(defaultRelation);
    void window.harbormaster.core.listRepositories().then(setRepositories);
    void window.harbormaster.core
      .getLaunchSettings()
      .then((settings) => setDefaultModel(settings.defaultModel));
  }, [open, defaultRelation]);

  function reset(): void {
    setTitle("");
    setPrompt("");
    setRepositoryChoice(SCRATCH_VALUE);
    setCloneUrl("");
    setBaseBranch("default");
    setModel("");
    setError(null);
  }

  function handleCancel(): void {
    reset();
    onOpenChange(false);
  }

  // "parent" base branch only ever applies to a child launched into the
  // parent's own repository, and only once the parent has a branch (a
  // parked backlog task has none yet) — see CoreCommands.launchTask's
  // rejection rule.
  const baseBranchEligible =
    relation === "child" &&
    !!fromTask.branch &&
    !!fromTask.repositoryId &&
    repositoryChoice === fromTask.repositoryId;

  useEffect(() => {
    if (!baseBranchEligible) setBaseBranch("default");
  }, [baseBranchEligible]);

  async function handleSubmit(): Promise<void> {
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedTitle || !trimmedPrompt || submitting) return;
    if (repositoryChoice === CLONE_URL_VALUE && !cloneUrl.trim()) {
      setError("Enter a clone URL, or pick a different repository.");
      return;
    }

    const repository: LaunchTaskInput["repository"] =
      repositoryChoice === SCRATCH_VALUE
        ? { none: true }
        : repositoryChoice === CLONE_URL_VALUE
          ? { cloneUrl: cloneUrl.trim() }
          : { repositoryId: repositoryChoice };

    setSubmitting(true);
    setError(null);
    try {
      const task = await window.harbormaster.core.launchTask({
        relation,
        fromTaskId: fromTask.id,
        title: trimmedTitle,
        prompt: trimmedPrompt,
        repository,
        ...(baseBranchEligible && baseBranch === "parent"
          ? { baseBranch: "parent" as const }
          : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      reset();
      onOpenChange(false);
      // Launching never steals focus/view (see module doc) — a toast is the
      // only signal, same pattern as the refresh-warning/error toasts.
      pushToast(`Launched ${task.title} — queued`, "success");
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !(repositoryChoice === CLONE_URL_VALUE && !cloneUrl.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel();
      }}
      title={relation === "child" ? "Launch subtask…" : "Launch task…"}
      testId="launch-task-dialog"
    >
      <div className="flex flex-col gap-3">
        <fieldset
          className="grid grid-cols-2 gap-1 rounded-md border border-border p-1"
          data-testid="launch-task-relation"
        >
          <legend className="sr-only">Relation</legend>
          {(
            [
              ["child", "Subtask", "Nested under this task; pollable"],
              ["standalone", "Task", "No lineage, no polling"],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              title={hint}
              data-testid={`launch-task-relation-${value}`}
              data-selected={relation === value}
              className={cn(
                "cursor-pointer rounded px-2 py-1 text-center text-xs font-medium transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                relation === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <input
                type="radio"
                name="launch-task-relation"
                value={value}
                className="sr-only"
                checked={relation === value}
                onChange={() => setRelation(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1">
          <Label htmlFor="launch-task-title">Title</Label>
          <Input
            id="launch-task-title"
            data-testid="launch-task-title-input"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Task title"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="launch-task-prompt">Prompt</Label>
          <textarea
            id="launch-task-prompt"
            data-testid="launch-task-prompt-input"
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the launched agent do? Sent as its first message."
            className="min-h-[84px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="launch-task-repo">Repository</Label>
          <select
            id="launch-task-repo"
            data-testid="launch-task-repo-select"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={repositoryChoice}
            onChange={(event) => setRepositoryChoice(event.target.value)}
          >
            <option value={SCRATCH_VALUE}>None (general)</option>
            {repositories.map((repo) => (
              <option
                key={repo.id}
                value={repo.id}
                data-testid="launch-task-repo-option"
              >
                {repositoryLabel(repo)}
              </option>
            ))}
            <option value={CLONE_URL_VALUE}>Clone URL…</option>
          </select>
          {repositoryChoice === CLONE_URL_VALUE && (
            <Input
              data-testid="launch-task-clone-url-input"
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
              className="mt-1"
            />
          )}
        </div>
        {baseBranchEligible && (
          <fieldset
            className="flex flex-col gap-1"
            data-testid="launch-task-base-branch"
          >
            <Label>Base branch</Label>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
              {(
                [
                  ["default", "Default", "The repository's default branch"],
                  [
                    "parent",
                    "Parent's branch",
                    `Stack on "${fromTask.branch}"`,
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  title={hint}
                  data-testid={`launch-task-base-branch-${value}`}
                  data-selected={baseBranch === value}
                  className={cn(
                    "cursor-pointer rounded px-2 py-1 text-center text-xs font-medium transition-colors",
                    baseBranch === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="launch-task-base-branch"
                    value={value}
                    className="sr-only"
                    checked={baseBranch === value}
                    onChange={() => setBaseBranch(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="launch-task-model">
            Model
            <span className="ml-1 font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <Input
            id="launch-task-model"
            data-testid="launch-task-model-input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={defaultModel ?? "harness default"}
          />
        </div>
        {error && (
          <p
            className="text-xs text-red-400"
            data-testid="launch-task-error"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-testid="launch-task-submit"
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting
            ? "Launching…"
            : relation === "child"
              ? "Launch subtask"
              : "Launch task"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
