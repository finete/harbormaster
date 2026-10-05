import type { JSX } from "react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * "+ New task" dialog: title (required) and repositoryId (optional, plain
 * text for now — repo picking/validation is a later phase). Always creates
 * into the backlog column via `createTask` (the only state `createTask`
 * ever puts a task in).
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
  const [repositoryId, setRepositoryId] = useState("");

  function reset(): void {
    setTitle("");
    setRepositoryId("");
  }

  function handleCancel(): void {
    reset();
    onOpenChange(false);
  }

  function handleSubmit(): void {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const trimmedRepo = repositoryId.trim();
    onCreate({
      title: trimmedTitle,
      ...(trimmedRepo ? { repositoryId: trimmedRepo } : {}),
    });
    reset();
    onOpenChange(false);
  }

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
          <Label htmlFor="new-task-repo">Repository (optional)</Label>
          <Input
            id="new-task-repo"
            data-testid="new-task-repo-input"
            value={repositoryId}
            onChange={(event) => setRepositoryId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSubmit();
            }}
            placeholder="github.com/org/repo"
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
          Create
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
