// Built-in source `harbormaster`: the board itself. One subject per
// (non-archived) task, so every move — manual or rule-driven — becomes a
// `harbormaster.task.<field>Changed` event on the next tick and rules
// re-evaluate when a task enters the state they care about. `pipeline`
// (the repository's stage ids) changes when the config does, so e.g. a
// stage-less production wait adopts a newly configured pipeline.
//
// Two live facts feed the "ready to review" trigger (docs/plannotator.md):
// `agent` (what the task's agent is doing, from presence) and
// `worktree.dirty` (uncommitted changes, Working tasks with a git worktree
// only) → `harbormaster.task.agentChanged` /
// `harbormaster.task.worktree.dirtyChanged`. Core serves `worktreeDirty` from
// its once-per-tick worktree pass (engines/worktree-status.ts), not a git run
// per read. A fact that cannot be read this
// tick keeps its previous value (no event); both are omitted when core
// wires no `services.tasks`.

import type {
  RuleTaskView,
  Snapshot,
  Source,
  SourceContext,
} from "../../contracts/rules.js";
import { forEachConcurrently } from "../../utilities/concurrency.js";
import { taskSubject } from "../rules/snapshot-diff.js";

export const HARBORMASTER_SOURCE_ID = "harbormaster";

/** The fact key behind `harbormaster.task.worktree.dirtyChanged` (read as `facts.harbormaster["worktree.dirty"]`). */
export const WORKTREE_DIRTY_FACT = "worktree.dirty";

/** Presence / worktree-status reads in flight at once. */
const LIVE_FACT_CONCURRENCY = 6;

type LiveFacts = { agent?: unknown; [WORKTREE_DIRTY_FACT]?: unknown };

async function liveFacts(ctx: SourceContext): Promise<Map<string, LiveFacts>> {
  const live = new Map<string, LiveFacts>();
  const services = ctx.services.tasks;
  if (!services) return live;
  const previous = new Map(
    ctx.previous.map((snapshot) => [snapshot.subject, snapshot.facts]),
  );
  await forEachConcurrently(
    ctx.tasks,
    LIVE_FACT_CONCURRENCY,
    async (task: RuleTaskView) => {
      const before = previous.get(taskSubject(task.id)) ?? {};
      const facts: LiveFacts = {};
      try {
        facts.agent = await services.agent(task.id);
      } catch {
        // Unreadable this tick: keep the last value, emit nothing.
        facts.agent = before.agent ?? null;
      }
      if (task.state === "working") {
        try {
          facts[WORKTREE_DIRTY_FACT] =
            (await services.worktreeDirty(task.id)) ?? null;
        } catch {
          facts[WORKTREE_DIRTY_FACT] = before[WORKTREE_DIRTY_FACT] ?? null;
        }
      } else {
        facts[WORKTREE_DIRTY_FACT] = null;
      }
      live.set(task.id, facts);
    },
  );
  return live;
}

export const harbormasterSource: Source = {
  id: HARBORMASTER_SOURCE_ID,
  interval: 0,
  async snapshot(ctx) {
    const pipelines = new Map(
      ctx.repositories.map((repo) => [
        repo.id,
        repo.deployment.stages.map((stage) => stage.id),
      ]),
    );
    const live = await liveFacts(ctx);
    return ctx.tasks.map(
      (task): Snapshot => ({
        subject: taskSubject(task.id),
        entity: "task",
        facts: {
          state: task.state,
          awaitingKind: task.awaiting?.kind ?? null,
          stageId:
            typeof task.awaiting?.stageId === "string"
              ? task.awaiting.stageId
              : null,
          repository: task.repository,
          branch: task.branch,
          pipeline: task.repository
            ? (pipelines.get(task.repository) ?? [])
            : [],
          ...(live.get(task.id) ?? {}),
        },
      }),
    );
  },
};
