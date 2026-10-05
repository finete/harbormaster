// Ported and adapted from pi-home's tests/unit/default-addons.test.ts for
// Harbormaster's simpler AwaitingKind (no separately tracked production
// commit/pull-request snapshot — `task.pr.mergeCommit` is the single source
// of truth once merged) and the dropped stage-less "manual production wait"
// (no pipeline configured => this mover stays out of the way, see
// deployment-pipeline-mover.ts's doc comment).

import { describe, expect, it, vi } from "vitest";
import type {
  MoverHelpers,
  MoverInput,
  MoverTaskView,
  StageHookInput,
  StageHookResult,
} from "../src/contracts/addons.js";
import type {
  DeploymentPipeline,
  TaskPullRequest,
} from "../src/contracts/model.js";
import { deploymentPipelineMover } from "../src/engines/movers/deployment-pipeline-mover.js";
import { githubReviewMover } from "../src/engines/movers/github-review-mover.js";

const pipeline: DeploymentPipeline = {
  releaseBranch: "releases/v{major}.{minor}.0",
  stages: [
    {
      id: "pre",
      label: "Preprod deploy",
      hook: "version-endpoint",
      options: { url: "https://pre.example/version" },
    },
    {
      id: "prod",
      label: "Production deploy",
      hook: "version-endpoint",
      options: { url: "https://prod.example/version" },
    },
  ],
};

const pr = (overrides: Partial<TaskPullRequest> = {}): TaskPullRequest => ({
  number: 1,
  state: "open",
  ...overrides,
});

function task(
  state: MoverTaskView["state"],
  awaiting?: MoverTaskView["awaiting"],
  pullRequest?: TaskPullRequest,
): MoverTaskView {
  return {
    id: "t1",
    kind: "task",
    state,
    repositoryId: "github.com/acme/widgets",
    branch: "alice/one",
    ...(awaiting ? { awaiting } : {}),
    ...(pullRequest ? { pr: pullRequest } : {}),
  };
}
function input(
  view: MoverTaskView,
  withPipeline?: DeploymentPipeline,
): MoverInput {
  return { task: view, ...(withPipeline ? { pipeline: withPipeline } : {}) };
}
function fakeHelpers(
  result:
    | StageHookResult
    | Error
    | ((input: StageHookInput) => StageHookResult) = {
    satisfied: false,
  },
): MoverHelpers & { runHook: ReturnType<typeof vi.fn> } {
  return {
    fetchText: vi.fn(async () => {
      throw new Error("unused");
    }),
    containsCommit: vi.fn(async () => {
      throw new Error("unused");
    }),
    commitLog: vi.fn(async () => {
      throw new Error("unused");
    }),
    runHook: vi.fn(async (_hook: string, hookInput: StageHookInput) => {
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result(hookInput) : result;
    }),
  };
}

describe("github-review default mover", () => {
  const helpers = fakeHelpers();

  it("preserves the observePullRequest matrix for review movements", async () => {
    const review = { kind: "review" as const };
    await expect(
      githubReviewMover.decide(
        input(task("dev", undefined, pr({ reviewRequested: true }))),
        helpers,
      ),
    ).resolves.toEqual({ type: "review" });
    await expect(
      githubReviewMover.decide(input(task("dev", undefined, pr())), helpers),
    ).resolves.toEqual({ type: "stay" });
    await expect(
      githubReviewMover.decide(
        input(
          task(
            "awaiting",
            review,
            pr({
              reviewDecision: "CHANGES_REQUESTED",
              changesRequestedOnHead: true,
            }),
          ),
        ),
        helpers,
      ),
    ).resolves.toEqual({ type: "dev" });
    await expect(
      githubReviewMover.decide(
        input(task("backlog", undefined, pr({ reviewRequested: true }))),
        helpers,
      ),
    ).resolves.toEqual({ type: "stay" });
  });

  it("leaves merges, Slack, deploy, and PR-less tasks alone", async () => {
    await expect(
      githubReviewMover.decide(
        input(task("dev", undefined, pr({ state: "merged" }))),
        helpers,
      ),
    ).resolves.toEqual({ type: "stay" });
    await expect(
      githubReviewMover.decide(
        input(
          task("awaiting", { kind: "slack" }, pr({ reviewRequested: true })),
        ),
        helpers,
      ),
    ).resolves.toEqual({ type: "stay" });
    await expect(
      githubReviewMover.decide(
        input(
          task(
            "awaiting",
            { kind: "deploy", stageId: "pre", stageLabel: "Preprod" },
            pr({ reviewRequested: true }),
          ),
        ),
        helpers,
      ),
    ).resolves.toEqual({ type: "stay" });
    await expect(
      githubReviewMover.decide(input(task("dev")), helpers),
    ).resolves.toEqual({
      type: "stay",
    });
  });
});

describe("deployment-pipeline default mover", () => {
  it("routes a merge into the first configured stage", async () => {
    const helpers = fakeHelpers();
    await expect(
      deploymentPipelineMover.decide(
        input(task("dev", undefined, pr({ state: "merged" })), pipeline),
        helpers,
      ),
    ).resolves.toEqual({
      type: "deploy",
      stageId: "pre",
      stageLabel: "Preprod deploy",
    });
    expect(helpers.runHook).not.toHaveBeenCalled();
  });

  it("stays out of the way entirely for a merge with no pipeline configured", async () => {
    const helpers = fakeHelpers();
    await expect(
      deploymentPipelineMover.decide(
        input(task("dev", undefined, pr({ state: "merged" }))),
        helpers,
      ),
    ).resolves.toEqual({ type: "stay" });
  });

  it("advances past a satisfied stage and lands after the last", async () => {
    const mergeCommit = { oid: "abc1234def", targetBranch: "main" };
    const preStage = {
      kind: "deploy" as const,
      stageId: "pre",
      stageLabel: "Preprod deploy",
    };
    const prodStage = {
      kind: "deploy" as const,
      stageId: "prod",
      stageLabel: "Production deploy",
    };

    const preOnly = fakeHelpers((hookInput) => ({
      satisfied: hookInput.stage.id === "pre",
    }));
    await expect(
      deploymentPipelineMover.decide(
        input(task("awaiting", preStage, pr({ mergeCommit })), pipeline),
        preOnly,
      ),
    ).resolves.toEqual({
      type: "deploy",
      stageId: "prod",
      stageLabel: "Production deploy",
    });
    expect(preOnly.runHook).toHaveBeenCalledWith("version-endpoint", {
      repositoryId: "github.com/acme/widgets",
      commit: { oid: "abc1234def", targetBranch: "main" },
      pullRequest: { number: 1 },
      branch: "alice/one",
      stage: { id: "pre", label: "Preprod deploy" },
      options: { url: "https://pre.example/version" },
    });

    await expect(
      deploymentPipelineMover.decide(
        input(task("awaiting", prodStage, pr({ mergeCommit })), pipeline),
        fakeHelpers({ satisfied: true }),
      ),
    ).resolves.toEqual({ type: "done" });

    await expect(
      deploymentPipelineMover.decide(
        input(task("awaiting", preStage, pr({ mergeCommit })), pipeline),
        fakeHelpers({ satisfied: false }),
      ),
    ).resolves.toEqual({ type: "stay" });
  });

  it("skips ahead when a later hooked stage is already satisfied (prod before pre)", async () => {
    const validated: DeploymentPipeline = {
      stages: [
        ...pipeline.stages,
        {
          id: "prod-validation",
          label: "Prod Validation",
          hook: "version-endpoint",
          options: {},
        },
      ],
    };
    const preStage = {
      kind: "deploy" as const,
      stageId: "pre",
      stageLabel: "Preprod deploy",
    };
    const prodOnly = fakeHelpers((hookInput) => ({
      satisfied: hookInput.stage.id === "prod",
    }));
    await expect(
      deploymentPipelineMover.decide(
        input(
          task(
            "awaiting",
            preStage,
            pr({ mergeCommit: { oid: "x", targetBranch: "main" } }),
          ),
          validated,
        ),
        prodOnly,
      ),
    ).resolves.toEqual({
      type: "deploy",
      stageId: "prod-validation",
      stageLabel: "Prod Validation",
    });
  });

  it("never scans past a manual (hookless) stage", async () => {
    const manualFirst: DeploymentPipeline = {
      stages: [
        { id: "manual", label: "Manual gate" },
        {
          id: "prod",
          label: "Production deploy",
          hook: "version-endpoint",
          options: {},
        },
      ],
    };
    const stage = {
      kind: "deploy" as const,
      stageId: "manual",
      stageLabel: "Manual gate",
    };
    const helpers = fakeHelpers({ satisfied: true });
    await expect(
      deploymentPipelineMover.decide(
        input(
          task(
            "awaiting",
            stage,
            pr({ mergeCommit: { oid: "x", targetBranch: "main" } }),
          ),
          manualFirst,
        ),
        helpers,
      ),
    ).resolves.toEqual({ type: "stay" });
    expect(helpers.runHook).not.toHaveBeenCalled();
  });
});
