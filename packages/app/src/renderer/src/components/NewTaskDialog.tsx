import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { RepositoryInfo } from "../../../preload/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const SCRATCH_VALUE = "";

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
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewTaskDialogResult) => void;
}): JSX.Element {
  const [destination, setDestination] = useState<NewTaskDestination>("start");
  const [title, setTitle] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [repositoryId, setRepositoryId] = useState(SCRATCH_VALUE);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);

  useEffect(() => {
    if (!open) return;
    void window.harbormaster.core.listRepositories().then(setRepositories);
  }, [open]);

  function reset(): void {
    setDestination("start");
    setInitialPrompt("");
    setTitle("");
    setRepositoryId(SCRATCH_VALUE);
  }

  function handleCancel(): void {
    reset();
    onOpenChange(false);
  }

  function handleSubmit(): void {
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
      title="New task"
      testId="new-task-dialog"
    >
      <div className="flex flex-col gap-3">
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
            <option value={SCRATCH_VALUE}>None / scratch</option>
            {repositories.map((repo) => (
              <option
                key={repo.id}
                value={repo.id}
                data-testid="new-task-repo-option"
              >
                {repo.id}
              </option>
            ))}
          </select>
          {branchPreview && (
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
              {destination === "start" ? "(recommended)" : "(optional)"}
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
              destination === "start"
                ? "What should pi do? Sent as the first message when the task's pi session starts."
                : "Description; sent as the first message once the task is started and its pi session opens."
            }
            className="min-h-[84px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-testid="new-task-submit"
          disabled={!title.trim()}
          onClick={handleSubmit}
        >
          {destination === "start" ? "Start task" : "Add to Backlog"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
