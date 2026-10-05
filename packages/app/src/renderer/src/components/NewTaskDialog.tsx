import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { RepositoryInfo } from "../../../preload/api";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const SCRATCH_VALUE = "";

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
 * "+ New task" dialog: title (required) and a repository picker populated
 * from `core.listRepositories()` (plus a "None / scratch" option for
 * repository-less work). Picking a repository previews the branch
 * `createTask` will derive for it. Always creates into the backlog column
 * via `createTask` (the only state `createTask` ever puts a task in).
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { title: string; repositoryId?: string }) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [repositoryId, setRepositoryId] = useState(SCRATCH_VALUE);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);

  useEffect(() => {
    if (!open) return;
    void window.harbormaster.core.listRepositories().then(setRepositories);
  }, [open]);

  function reset(): void {
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
          Create
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
