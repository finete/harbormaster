// Engine: stateless board-grouping rules. Used by the Manager; no I/O, no session state — pure projection
// over a list of tasks already in one column.

import type { BoardGroup, Task, TaskState } from "../contracts/model.js";

const AWAITING_PRIMARY_LABELS = {
  review: "Review",
  slack: "Slack response",
  "author-response": "Author response",
} as const;

function repoShortName(repositoryId: string): string {
  const segments = repositoryId.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? repositoryId;
}

function sortByStateChangedAt(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) =>
    a.stateChangedAt.localeCompare(b.stateChangedAt),
  );
}

interface AwaitingGroupKey {
  /** Sort precedence: deploy stages (by label) first, then review, then slack. */
  order: [0 | 1 | 2, string];
  primaryLabel: string;
  groupKindId: string;
}

function awaitingGroupKey(task: Task): AwaitingGroupKey {
  const awaiting = task.awaiting ?? { kind: "review" as const };
  if (awaiting.kind === "deploy") {
    return {
      order: [0, awaiting.stageLabel],
      primaryLabel: awaiting.stageLabel,
      groupKindId: `deploy:${awaiting.stageId}`,
    };
  }
  if (awaiting.kind === "author-response") {
    return {
      order: [1, "author-response"],
      primaryLabel: AWAITING_PRIMARY_LABELS["author-response"],
      groupKindId: "author-response",
    };
  }
  if (awaiting.kind === "slack") {
    return {
      order: [2, ""],
      primaryLabel: AWAITING_PRIMARY_LABELS.slack,
      groupKindId: "slack",
    };
  }
  return {
    order: [1, ""],
    primaryLabel: AWAITING_PRIMARY_LABELS.review,
    groupKindId: "review",
  };
}

/** Group one board column's tasks per the rules in the task spec. */
export function groupColumnTasks(
  state: TaskState,
  tasks: Task[],
): BoardGroup[] {
  if (state === "awaiting") return groupAwaitingColumn(tasks);
  return groupByRepository(tasks);
}

function groupAwaitingColumn(tasks: Task[]): BoardGroup[] {
  // Group by (awaiting kind/stage, repositoryId): bucket by the awaiting
  // group key first, then subdivide each bucket by repository.
  const byKind = new Map<
    string,
    { order: AwaitingGroupKey["order"]; primaryLabel: string; tasks: Task[] }
  >();
  for (const task of tasks) {
    const key = awaitingGroupKey(task);
    const existing = byKind.get(key.groupKindId);
    if (existing) existing.tasks.push(task);
    else
      byKind.set(key.groupKindId, {
        order: key.order,
        primaryLabel: key.primaryLabel,
        tasks: [task],
      });
  }

  const kindGroups = [...byKind.values()].sort((a, b) => {
    if (a.order[0] !== b.order[0]) return a.order[0] - b.order[0];
    return a.order[1].localeCompare(b.order[1]);
  });

  const groups: BoardGroup[] = [];
  for (const kindGroup of kindGroups) {
    const repoGroups = groupByRepository(kindGroup.tasks);
    for (const repoGroup of repoGroups) {
      groups.push({
        id: `${kindGroup.primaryLabel}::${repoGroup.id}`,
        primaryLabel: kindGroup.primaryLabel,
        ...(repoGroup.repoLabel !== undefined
          ? { repoLabel: repoGroup.repoLabel }
          : {}),
        tasks: repoGroup.tasks,
      });
    }
  }
  return groups;
}

function groupByRepository(tasks: Task[]): BoardGroup[] {
  const byRepo = new Map<string, Task[]>();
  const scratch: Task[] = [];
  for (const task of tasks) {
    if (task.repositoryId === undefined) {
      scratch.push(task);
      continue;
    }
    const existing = byRepo.get(task.repositoryId);
    if (existing) existing.push(task);
    else byRepo.set(task.repositoryId, [task]);
  }

  const groups: BoardGroup[] = [...byRepo.entries()]
    .sort((a, b) => repoShortName(a[0]).localeCompare(repoShortName(b[0])))
    .map(([repositoryId, repoTasks]) => ({
      id: repositoryId,
      repoLabel: repoShortName(repositoryId),
      tasks: sortByStateChangedAt(repoTasks),
    }));

  if (scratch.length > 0) {
    groups.push({
      id: "scratch",
      repoLabel: "scratch",
      tasks: sortByStateChangedAt(scratch),
    });
  }
  return groups;
}
