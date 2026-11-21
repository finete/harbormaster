import { Loader2, RotateCcw } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import { reopenTaskMutation } from "../lib/task-mutations";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/**
 * What a Done (or archived) task's workspace shows instead of a pane while
 * it has nothing to run in: Done cleanup removed its worktree (a folder or
 * scratch task's binding is parked), so there is no agent to attach to.
 * Resume is the header's Reopen without the objective question: back to
 * Working in a fresh worktree (or its folder / scratch directory), and the
 * workspace's first pane picks the previous conversation back up. Opening a
 * Done task never changes its state by itself.
 */
export function ResumeTaskCard({ task }: { task: Task }): JSX.Element {
  const [busy, setBusy] = useState(false);
  // The reopen landed (the task left Done) and the workspace is waiting on
  // the new cycle's worktree before it starts the agent.
  const starting = task.state !== "done";
  const where = task.repositoryId
    ? "a fresh branch and worktree"
    : task.folderPath
      ? "its folder"
      : "its scratch directory";

  async function resume(): Promise<void> {
    if (busy || starting) return;
    setBusy(true);
    try {
      await reopenTaskMutation(task.id, "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid={`resume-task-${task.id}`}
      className="flex h-full flex-col items-center justify-center gap-3 bg-background px-4 text-center"
    >
      <p className="text-sm font-medium">
        {task.archivedAt ? "This task is archived" : "This task is done"}
      </p>
      <p className="max-w-sm text-xs text-muted-foreground">
        No agent runs here. Resume moves it back to Working in {where} and picks
        up where it left off.
      </p>
      <Button
        // The first open (a click or Enter on the board) lands here, so a
        // second Enter resumes it.
        autoFocus
        disabled={busy || starting}
        onClick={() => void resume()}
        data-testid={`resume-task-button-${task.id}`}
      >
        {busy || starting ? (
          <Loader2 className="animate-spin" />
        ) : (
          <RotateCcw />
        )}
        {starting ? "Starting…" : "Resume"}
        {!starting && <Kbd>⏎</Kbd>}
      </Button>
    </div>
  );
}
