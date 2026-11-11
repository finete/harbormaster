// Built-in source `harbormaster`: the board itself. One subject per
// (non-archived) task, so every move — manual or rule-driven — becomes a
// `harbormaster.task.<field>Changed` event on the next tick and rules
// re-evaluate when a task enters the state they care about. `pipeline`
// (the repository's stage ids) changes when the config does, so e.g. a
// stage-less production wait adopts a newly configured pipeline.

import type { Snapshot, Source } from "../../contracts/rules.js";
import { taskSubject } from "../rules/snapshot-diff.js";

export const HARBORMASTER_SOURCE_ID = "harbormaster";

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
        },
      }),
    );
  },
};
