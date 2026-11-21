// Engine: builds the kickoff contract appended to a `launchTask` prompt (see
// /docs/design-decisions.md "Launching tasks from an agent" "Kickoff contract"). Pure text generation, no
// I/O, no session state -- an Engine per /docs/design-decisions.md "Layering".

/** Input to {@link buildLaunchKickoffPrompt}. */
export interface LaunchKickoffInput {
  /** Whether the task has a repository/worktree (repository-less tasks skip commit/push/PR points). */
  hasRepository: boolean;
  /** The launching task, for a `child` relation (names it so the agent knows its context). */
  parent?: { title: string; id: string };
  /** Set when `baseBranch: "parent"`: the branch this task's worktree was based on, named so the agent states the dependency. */
  dependencyBranch?: string;
  /** Set for a PR-bound task: the worktree is the PR head; the role decides push/PR points. */
  pullRequest?: { number: number; role: "author" | "reviewer" };
  /** A chat: runs directly in the user's folder/checkout, no worktree. */
  inPlace?: boolean;
  /** Set (to `launch.maxNestingDepth`) when the task sits AT the max nesting depth: it cannot launch subtasks (docs/task-trees.md decision 8). */
  atMaxNestingDepth?: number;
}

/**
 * The kickoff contract appended to every `launchTask` prompt. Adapted from
 * pi-home's autonomy contract (see the PRD): six numbered points, the first
 * two (worktree discipline, running checks) and the last two (ask-or-
 * decide, final report) always present; the middle two (commit/push, open a
 * draft PR) only for a repository-backed task. A PR-bound launch swaps
 * them for "push to the existing PR" (author) or "never push" (reviewer);
 * a chat (in place) states that edits land in the user's folder. A task AT
 * the max nesting depth gets one more point saying it cannot launch
 * subtasks. The tool name in point 6 is
 * the catalog's `report_status` (see `tools/catalog.ts`).
 */
export function buildLaunchKickoffPrompt(input: LaunchKickoffInput): string {
  const lines: string[] = [];
  if (input.parent) {
    lines.push(
      `Launched as a subtask of: ${input.parent.title} (${input.parent.id})`,
      "",
    );
  }
  lines.push("Before you start, follow this contract:", "");

  const pr = input.pullRequest;
  const points: string[] = [
    input.inPlace
      ? "You are running directly in the user's folder (no worktree): any edit lands in it as-is, so change files only when the prompt asks for it."
      : pr
        ? `Work only inside this task's worktree: a checkout of pull request #${pr.number}'s head branch.`
        : "Work only inside this task's worktree.",
  ];
  if (pr?.role === "reviewer") {
    points.push(
      `You are REVIEWING pull request #${pr.number} (someone else's work): never commit, push, or open a pull request.`,
    );
  } else if (pr) {
    points.push(
      "Run the repository's relevant checks/tests for your change.",
      `Commit with a clear message and push to the PR's branch: pull request #${pr.number} already exists, never open another one.`,
    );
  } else if (!input.inPlace) {
    points.push("Run the repository's relevant checks/tests for your change.");
  }
  if (input.hasRepository && !pr) {
    points.push(
      "Commit with a clear message and push the branch.",
      input.dependencyBranch
        ? `Open a DRAFT pull request (\`gh pr create --draft\`) targeting the default branch. Your worktree is based on "${input.dependencyBranch}" (another task's branch, not yet merged) -- state that dependency at the top of the PR description.`
        : "Open a DRAFT pull request (`gh pr create --draft`) targeting the default branch. If you based on / merged another task's branch, state the dependency at the top of the PR description.",
    );
  }
  if (input.atMaxNestingDepth !== undefined) {
    points.push(
      `You are at the max nesting depth (${input.atMaxNestingDepth}), so you cannot launch subtasks: do the work yourself, or launch standalone tasks.`,
    );
  }
  points.push(
    input.parent
      ? `If you are genuinely blocked or need a decision, you may ask your parent task (${input.parent.id}) with the Harbormaster \`send_to_task\` tool and then end your turn; it can only answer what its brief settles. Product or scope decisions, or a parent that is unavailable (the send fails), go to the user: stop and ask -- the user sees your task as "your move". Otherwise do not stop to ask; make reasonable decisions and note them.`
      : `If you are genuinely blocked or need a decision, stop and ask -- the user sees your task as "your move". Otherwise do not stop to ask; make reasonable decisions and note them.`,
    "As your FINAL action call the Harbormaster `report_status` tool: `done` with a one-line summary, or `blocked` with the concrete blocker.",
  );

  points.forEach((point, index) => {
    lines.push(`${index + 1}. ${point}`);
  });
  return lines.join("\n");
}
