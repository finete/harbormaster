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

const SCRATCH_VALUE = "";
const CLONE_URL_VALUE = "__clone-url__";

/** How a new task relates to the focused task: none = plain create; the others launch. */
type NewTaskLink = "none" | "child" | "standalone";

/** pi-home's create choice, minus temp work (deferred by design). */
export type NewTaskDestination = "start" | "backlog";

/**
 * What the dialog hands its `onCreate` caller. The fields past `title` /
 * `repositoryId` are optional so older call sites that only forward those
 * two keep compiling (they simply park in Backlog with no prompt).
 */
export interface NewTaskDialogResult {
  title: string;
  repositoryId?: string;
  /** Multiline first message for the task's pi session; may be empty. */
  initialPrompt?: string;
  /** `true` = "Start now" (lands in Dev, worktree created); absent/false = park in Backlog. */
  start?: boolean;
}

/**
 * Lowercase, hyphenated preview slug — mirrors (but does not need to match
 * byte-for-byte) @harbormaster/core's `engines/task-workspace.ts
 * slugify()`: the real branch name (prefix + slug + first 6 id chars) is
 * only known once `createTask` assigns the task its id, so this is a
 * best-effort preview, not the authoritative value.
 */
function previewSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

/**
 * "+ New task" dialog, pi-home style: a destination choice ("Start now",
 * the default, vs "Park in Backlog"), title (required), a repository picker
 * populated from `core.listRepositories()` (plus "None / scratch"), and a
 * multiline initial prompt. Starting now lands the task in Dev with its
 * branch + worktree created immediately, and the prompt becomes the first
 * message of its pi session; parking stores everything but creates no
 * branch/worktree until the card is started.
 *
 * Launching (see ai/prds/task-launching.md) is folded in here as the one
 * entry point: when a `fromTask` is supplied (the sidebar passes the focused
 * task) a "Link" control offers `None` | `Subtask of this` (relation
 * `child`) | `Launched from this` (relation `standalone`). Anything but
 * `None` switches to launch mode: no destination picker, the prompt is
 * required, Clone URL / base-branch / model options appear, and submit calls
 * `core.launchTask` directly instead of `onCreate`.
 *
 * Launching queues a background session and NEVER switches view or focus to
 * the new task (the PRD's "launching never steals focus"): a toast is the
 * only acknowledgement. Thrown errors surface inline instead (the dialog
 * stays open so the user can fix the input).
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onCreate,
  fromTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewTaskDialogResult) => void;
  /** The task a launch would originate from (the focused task); omit/null = plain create only. */
  fromTask?: Task | null;
}): JSX.Element {
  const [destination, setDestination] = useState<NewTaskDestination>("start");
  const [title, setTitle] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [repositoryId, setRepositoryId] = useState(SCRATCH_VALUE);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [link, setLink] = useState<NewTaskLink>("none");
  const [cloneUrl, setCloneUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState<"default" | "parent">("default");
  const [model, setModel] = useState("");
  const [defaultModel, setDefaultModel] = useState<string | undefined>(
    undefined,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLink("none");
    void window.harbormaster.core.listRepositories().then(setRepositories);
    void window.harbormaster.core
      .getLaunchSettings()
      .then((settings) => setDefaultModel(settings.defaultModel));
  }, [open]);

  const launching = !!fromTask && link !== "none";
  // One level only (see ai/prds/task-launching.md): a task that is itself a
  // child can never launch further children, only standalone tasks.
  const canLaunchChild = !!fromTask && !fromTask.parentTaskId;
  // "parent" base branch only ever applies to a child launched into the
  // parent's own repository, and only once the parent has a branch (a
  // parked backlog task has none yet) — see CoreCommands.launchTask's
  // rejection rule.
  const baseBranchEligible =
    launching &&
    link === "child" &&
    !!fromTask?.branch &&
    !!fromTask?.repositoryId &&
    repositoryId === fromTask.repositoryId;

  useEffect(() => {
    if (!baseBranchEligible) setBaseBranch("default");
  }, [baseBranchEligible]);

  function reset(): void {
    setDestination("start");
    setInitialPrompt("");
    setTitle("");
    setRepositoryId(SCRATCH_VALUE);
    setLink("none");
    setCloneUrl("");
    setBaseBranch("default");
    setModel("");
    setError(null);
  }

  function handleCancel(): void {
    reset();
    onOpenChange(false);
  }

  async function handleLaunch(): Promise<void> {
    if (!fromTask || link === "none") return;
    const trimmedTitle = title.trim();
    const trimmedPrompt = initialPrompt.trim();
    if (!trimmedTitle || !trimmedPrompt || submitting) return;
    if (repositoryId === CLONE_URL_VALUE && !cloneUrl.trim()) {
      setError("Enter a clone URL, or pick a different repository.");
      return;
    }
    const repository: LaunchTaskInput["repository"] =
      repositoryId === SCRATCH_VALUE
        ? { none: true }
        : repositoryId === CLONE_URL_VALUE
          ? { cloneUrl: cloneUrl.trim() }
          : { repositoryId };
    setSubmitting(true);
    setError(null);
    try {
      const task = await window.harbormaster.core.launchTask({
        relation: link,
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
      // Launching never steals focus/view (see component doc) — a toast is
      // the only signal.
      pushToast(`Launched ${task.title} — queued`, "success");
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(): void {
    if (launching) {
      void handleLaunch();
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    onCreate({
      title: trimmedTitle,
      ...(repositoryId ? { repositoryId } : {}),
      initialPrompt: initialPrompt.trim() ? initialPrompt : "",
      start: destination === "start",
    });
    reset();
    onOpenChange(false);
  }

  const canSubmit = launching
    ? title.trim().length > 0 &&
      initialPrompt.trim().length > 0 &&
      !(repositoryId === CLONE_URL_VALUE && !cloneUrl.trim()) &&
      !submitting
    : title.trim().length > 0;

  const selectedRepo = repositories.find((repo) => repo.id === repositoryId);
  const branchPreview =
    selectedRepo && title.trim()
      ? `${previewSlug(title)}-\u2026 \u2192 ${selectedRepo.defaultBranch}`
      : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={launching && link === "child" ? "New subtask" : "New task"}
      testId="new-task-dialog"
    >
      <div className="flex flex-col gap-3">
        {fromTask && (
          <div className="flex flex-col gap-1">
            <fieldset
              className="grid grid-cols-3 gap-1 rounded-md border border-border p-1"
              data-testid="new-task-link"
            >
              <legend className="sr-only">Link</legend>
              {(
                [
                  ["none", "None", "A plain new task, unrelated to this one"],
                  [
                    "child",
                    "Subtask of this",
                    canLaunchChild
                      ? "Launch a child task: nested under this one, pollable"
                      : "A child task cannot launch further children (one level only)",
                  ],
                  [
                    "standalone",
                    "Launched from this",
                    "Launch a standalone task: no lineage, no polling",
                  ],
                ] as const
              ).map(([value, label, hint]) => {
                const disabled = value === "child" && !canLaunchChild;
                return (
                  <label
                    key={value}
                    title={hint}
                    data-testid={`new-task-link-${value}`}
                    data-selected={link === value}
                    className={cn(
                      "rounded px-2 py-1 text-center text-xs font-medium transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                      disabled
                        ? "cursor-not-allowed text-muted-foreground opacity-50"
                        : "cursor-pointer",
                      link === value
                        ? "bg-primary text-primary-foreground"
                        : cn(
                            "text-muted-foreground",
                            !disabled && "hover:bg-muted",
                          ),
                    )}
                  >
                    <input
                      type="radio"
                      name="new-task-link"
                      value={value}
                      className="sr-only"
                      disabled={disabled}
                      checked={link === value}
                      onChange={() => setLink(value)}
                    />
                    {label}
                  </label>
                );
              })}
            </fieldset>
            {link !== "none" && (
              <p className="truncate text-[11px] text-muted-foreground">
                {link === "child" ? "Subtask of" : "Launched from"}{" "}
                {fromTask.title}
              </p>
            )}
          </div>
        )}
        {launching ? (
          <p className="text-xs text-muted-foreground">
            Runs in the background — focus stays here
          </p>
        ) : (
          <fieldset
            className="grid grid-cols-2 gap-1 rounded-md border border-border p-1"
            data-testid="new-task-destination"
          >
            <legend className="sr-only">Destination</legend>
            {(
              [
                ["start", "Start now", "Lands in Dev; worktree created now"],
                ["backlog", "Park in Backlog", "No branch or worktree yet"],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                title={hint}
                data-testid={`new-task-destination-${value}`}
                data-selected={destination === value}
                className={cn(
                  "cursor-pointer rounded px-2 py-1 text-center text-xs font-medium transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                  destination === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <input
                  type="radio"
                  name="new-task-destination"
                  value={value}
                  className="sr-only"
                  checked={destination === value}
                  onChange={() => setDestination(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-task-title">Title</Label>
          <Input
            id="new-task-title"
            data-testid="new-task-title-input"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSubmit();
            }}
            placeholder="Task title"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-task-repo">Repository</Label>
          <select
            id="new-task-repo"
            data-testid="new-task-repo-select"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={repositoryId}
            onChange={(event) => setRepositoryId(event.target.value)}
          >
            <option value={SCRATCH_VALUE}>
              {launching ? "None (general)" : "None / scratch"}
            </option>
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
          {launching && repositoryId === CLONE_URL_VALUE && (
            <Input
              data-testid="new-task-clone-url-input"
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
              className="mt-1"
            />
          )}
          {!launching && branchPreview && (
            <p
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="new-task-branch-preview"
            >
              {branchPreview}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-task-prompt">
            Initial prompt
            <span className="ml-1 font-normal text-muted-foreground">
              {launching
                ? "(required)"
                : destination === "start"
                  ? "(recommended)"
                  : "(optional)"}
            </span>
          </Label>
          <textarea
            id="new-task-prompt"
            data-testid="new-task-prompt-input"
            rows={4}
            value={initialPrompt}
            onChange={(event) => setInitialPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                handleSubmit();
              }
            }}
            placeholder={
              launching
                ? "What should the launched agent do? Sent as its first message."
                : destination === "start"
                  ? "What should pi do? Sent as the first message when the task's pi session starts."
                  : "Description; sent as the first message once the task is started and its pi session opens."
            }
            className="min-h-[84px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        {baseBranchEligible && fromTask && (
          <fieldset
            className="flex flex-col gap-1"
            data-testid="new-task-base-branch"
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
                  data-testid={`new-task-base-branch-${value}`}
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
                    name="new-task-base-branch"
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
        {launching && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-task-model">
              Model
              <span className="ml-1 font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="new-task-model"
              data-testid="new-task-model-input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={defaultModel ?? "harness default"}
            />
          </div>
        )}
        {launching && error && (
          <p
            className="text-xs text-red-400"
            data-testid="new-task-error"
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
          data-testid="new-task-submit"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {launching
            ? submitting
              ? "Launching…"
              : link === "child"
                ? "Launch subtask"
                : "Launch task"
            : destination === "start"
              ? "Start task"
              : "Add to Backlog"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
