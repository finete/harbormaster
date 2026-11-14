import type { JSX } from "react";
import type { Task } from "../../../preload/api";
import { taskRepoLabel } from "../lib/repository-label";
import { cn } from "../lib/utils";

/**
 * The quiet repo chip on every board card (TaskCard.tsx) and sidebar row
 * (SidebarTaskRow.tsx): the task's short repository name, or "scratch"
 * (lib/repository-label.ts's `taskRepoLabel`). Same chip geometry as the
 * sidebar's state chip, but mono, with a faint hairline border, muted text and no fill, so
 * the state chip stays the primary signal. Needed because lineage can host a
 * cross-repo child under its parent's repo header (lib/task-lineage.ts).
 */
export function RepoChip({
  task,
  testId,
  className,
}: {
  task: Pick<Task, "repositoryId">;
  testId: string;
  className?: string;
}): JSX.Element {
  const label = taskRepoLabel(task);
  return (
    <span
      data-testid={testId}
      title={task.repositoryId ?? "No repository (scratch)"}
      className={cn(
        "inline-flex h-[18px] min-w-0 max-w-[10rem] shrink-0 items-center rounded border border-border/60 px-1.5 font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
