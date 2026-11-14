// Parity proof for the rules engine (docs/release-plan.md "Built-in rules
// (replace the two movers)"): recorded sequences of PR / deployment states
// are fed through BOTH the retired movers (kept verbatim under
// tests/fixtures/legacy-movers/) and the real RulesRuntime running the
// default rules.yaml with the built-in sources, one refresh tick at a time,
// and the board moves must be identical tick for tick. A second suite runs
// the whole observePullRequest matrix (every task state × PR shape) as a
// first observation through both.

import { describe, expect, it } from "vitest";
import type {
  CommitLogEntry,
  PullRequestStatus,
} from "../src/contracts/github.js";
import type {
  AwaitingKind,
  DeploymentPipeline,
  GlobalConfig,
  Task,
  TaskPullRequest,
} from "../src/contracts/model.js";
import type {
  AuditEntry,
  PendingRuleMove,
  SourceState,
} from "../src/contracts/rules.js";
import { DEFAULT_RULES_YAML } from "../src/engines/rules/default-rules.js";
import { RulesRuntime } from "../src/manager/rules-runtime.js";
import type { BoardMove, TaskMover } from "./fixtures/legacy-movers/addons.js";
import {
  arbitrateMove,
  deploymentPipelineMover,
  githubReviewMover,
  versionEndpointHook,
} from "./fixtures/legacy-movers/index.js";

const REPO = "github.com/acme/widgets";
const PRE_URL = "https://pre.example/version";
const PROD_URL = "https://prod.example/version";
const MERGE = "abcdef0123456";

const TWO_STAGES: DeploymentPipeline = {
  stages: [
    {
      id: "pre",
      label: "Preprod",
      hook: "version-endpoint",
      options: { url: PRE_URL },
    },
    {
      id: "prod",
      label: "Production",
      hook: "version-endpoint",
      options: { url: PROD_URL },
    },
  ],
};

/** One recorded observation: what GitHub and the version endpoints said this tick. */
interface Step {
  pr?: Partial<PullRequestStatus>;
  /** Deployed commit per endpoint URL (`v1.0.0+<commit>`). */
  deployed?: Record<string, string>;
  /** Deployed commits that contain the merge commit. */
  contains?: string[];
  /** Commit log reachable from a deployed commit (hotfix scan). */
  log?: Record<string, CommitLogEntry[]>;
  /** Auto-landing is refused this tick (dirty worktree / live pane). */
  landingBlocked?: boolean;
  /** A manual move made before this tick (the user, not automation). */
  manual?: { state: Task["state"]; awaiting?: AwaitingKind };
  /** Config pipeline from this tick on. */
  pipeline?: DeploymentPipeline | null;
}

function status(partial: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 42,
    url: `https://${REPO}/pull/42`,
    state: "OPEN",
    isDraft: false,
    reviewRequested: false,
    reviewSubmitted: false,
    headRefOid: "head1",
    checkedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

/** The persisted `task.pr` refresh() derives from a status (as core does). */
function taskPr(s: PullRequestStatus): TaskPullRequest {
  return {
    number: s.number,
    url: s.url,
    state:
      s.state === "MERGED"
        ? "merged"
        : s.state === "CLOSED"
          ? "closed"
          : s.isDraft
            ? "draft"
            : "open",
    ...(s.reviewDecision ? { reviewDecision: s.reviewDecision } : {}),
    ...(s.changesRequestedOnHead === undefined
      ? {}
      : { changesRequestedOnHead: s.changesRequestedOnHead }),
    ...(s.humanFeedbackOnHead === undefined
      ? {}
      : { humanFeedbackOnHead: s.humanFeedbackOnHead }),
    reviewRequested: s.reviewRequested,
    reviewSubmitted: s.reviewSubmitted,
    ...(s.headRefOid ? { headRefOid: s.headRefOid } : {}),
    ...(s.mergeCommit
      ? {
          mergeCommit: {
            oid: s.mergeCommit.oid,
            targetBranch: s.mergeCommit.targetBranch ?? "main",
          },
        }
      : {}),
  };
}

function baseTask(state: Task["state"], awaiting?: AwaitingKind): Task {
  return {
    id: "t1",
    kind: "task",
    state,
    title: "Widget",
    initialPrompt: "",
    repositoryId: REPO,
    branch: "alice/widget",
    ...(awaiting ? { awaiting } : {}),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    stateChangedAt: "2026-01-01T00:00:00Z",
  };
}

/** What a tick left the task as (`null` = it did not move). */
type Outcome = { state: Task["state"]; awaiting?: AwaitingKind } | null;

interface World {
  step: Step;
  pipeline: DeploymentPipeline | undefined;
}

function apply(task: Task, state: Task["state"], awaiting?: AwaitingKind) {
  task.state = state;
  if (awaiting) task.awaiting = awaiting;
  else delete task.awaiting;
}

/** The retired movers, exactly as refresh() ran them. */
class LegacyBoard {
  readonly task: Task;
  constructor(initial: Task) {
    this.task = structuredClone(initial);
  }
  async tick(world: World, observed: PullRequestStatus | undefined) {
    if (observed) this.task.pr = taskPr(observed);
    const helpers = {
      fetchText: async (url: string) => fetchFrom(world, url),
      containsCommit: async (_a: string, d: string) =>
        (world.step.contains ?? []).includes(d),
      commitLog: async (start: string) => world.step.log?.[start] ?? [],
      runHook: async (name: string, input: never) => {
        if (name !== "version-endpoint") throw new Error("unknown hook");
        return versionEndpointHook.check(input, helpers);
      },
    };
    const movers: Array<[string, TaskMover]> = [
      ["github-review", githubReviewMover],
      ["deployment-pipeline", deploymentPipelineMover],
    ];
    const { task } = this;
    const decision = await arbitrateMove(
      {
        task: {
          id: task.id,
          kind: task.kind,
          state: task.state,
          ...(task.awaiting ? { awaiting: task.awaiting } : {}),
          ...(task.branch ? { branch: task.branch } : {}),
          ...(task.repositoryId ? { repositoryId: task.repositoryId } : {}),
          ...(task.pr ? { pr: task.pr } : {}),
        },
        ...(world.pipeline ? { pipeline: world.pipeline } : {}),
      },
      helpers,
      movers,
    );
    return this.execute(decision.move, world);
  }
  private execute(move: BoardMove, world: World): Outcome {
    switch (move.type) {
      case "stay":
        return null;
      case "dev":
        apply(this.task, "dev");
        break;
      case "review":
        apply(this.task, "awaiting", { kind: "review" });
        break;
      case "deploy":
        apply(this.task, "awaiting", {
          kind: "deploy",
          stageId: move.stageId,
          stageLabel: move.stageLabel,
        });
        break;
      case "done":
        if (world.step.landingBlocked) return null;
        apply(this.task, "done");
        break;
    }
    return snapshot(this.task);
  }
}

/** The rules engine: the real RulesRuntime with in-memory storage and the default rules. */
class RulesBoard {
  readonly task: Task;
  private readonly states = new Map<string, SourceState>();
  private pending: PendingRuleMove[] = [];
  readonly audit: AuditEntry[] = [];
  private world: World | undefined;
  private readonly runtime: RulesRuntime;
  constructor(initial: Task, rulesYaml = DEFAULT_RULES_YAML) {
    this.task = structuredClone(initial);
    this.runtime = new RulesRuntime({
      rules: {
        hasGlobalRules: async () => true,
        writeDefaults: async () => {},
        writeManaged: async () => {},
        readRuleFiles: async () => [
          {
            file: "rules.yaml",
            path: "/state/rules/rules.yaml",
            text: rulesYaml,
          },
        ],
        importModule: async () => {
          throw new Error("no modules");
        },
      },
      state: {
        read: async (id) =>
          structuredClone(this.states.get(id) ?? { subjects: {} }),
        write: async (id, state) => {
          this.states.set(id, structuredClone(state));
        },
        readPending: async () => structuredClone(this.pending),
        writePending: async (pending) => {
          this.pending = structuredClone(pending);
        },
      },
      audit: {
        append: async (entries) => {
          this.audit.push(...entries);
        },
        read: async () => this.audit,
      },
      config: {
        load: async () => ({ automation: true }),
        save: async () => {},
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
      services: {
        github: {
          containsCommit: async (_r, _a, d) =>
            (this.world?.step.contains ?? []).includes(d),
          commitLog: async (_r, start) => this.world?.step.log?.[start] ?? [],
        },
        http: {
          fetchText: async (url) => fetchFrom(this.world as World, url),
        },
      },
    });
  }
  async tick(world: World, observed: PullRequestStatus | undefined) {
    this.world = world;
    if (observed) this.task.pr = taskPr(observed);
    const config: GlobalConfig = {
      automation: true,
      ...(world.pipeline
        ? { repositories: { [REPO]: { deployment: world.pipeline } } }
        : {}),
    };
    let outcome: Outcome = null;
    const result = await this.runtime.tick({
      tasks: [structuredClone(this.task)],
      config,
      observed: new Map(observed ? [[this.task.id, { status: observed }]] : []),
      protectedPaths: [],
      executor: {
        move: async (_task, move) => {
          if (move.state === "done" && world.step.landingBlocked) {
            return { outcome: "stayed", detail: "dirty" };
          }
          apply(this.task, move.state, move.awaiting);
          outcome = snapshot(this.task);
          return { outcome: "applied" };
        },
        inbox: async () => ({ outcome: "applied" }),
        createTask: async () => ({ outcome: "applied" }),
        message: async () => ({ outcome: "applied" }),
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.sourceFailures).toEqual([]);
    return outcome;
  }
}

function fetchFrom(world: World, url: string): string {
  const commit = world.step.deployed?.[url];
  if (!commit) throw new Error(`no fake document for ${url}`);
  return `v1.0.0+${commit}`;
}

function snapshot(task: Task): Outcome {
  return {
    state: task.state,
    ...(task.awaiting ? { awaiting: { ...task.awaiting } } : {}),
  };
}

/** Replay `steps` through both engines; returns each engine's per-tick outcomes. */
async function replay(
  initial: Task,
  steps: Step[],
  pipeline: DeploymentPipeline | undefined,
) {
  const legacy = new LegacyBoard(initial);
  const rules = new RulesBoard(initial);
  const legacyMoves: Outcome[] = [];
  const rulesMoves: Outcome[] = [];
  let current = pipeline;
  let lastPr: Partial<PullRequestStatus> | undefined;
  for (const step of steps) {
    if (step.pipeline !== undefined) current = step.pipeline ?? undefined;
    if (step.manual) {
      apply(legacy.task, step.manual.state, step.manual.awaiting);
      apply(rules.task, step.manual.state, step.manual.awaiting);
    }
    lastPr = step.pr ?? lastPr;
    const observed = lastPr ? status(lastPr) : undefined;
    const world: World = { step, pipeline: current };
    legacyMoves.push(await legacy.tick(world, observed));
    rulesMoves.push(await rules.tick(world, observed));
  }
  return { legacyMoves, rulesMoves, rules };
}

const merged = (extra: Partial<PullRequestStatus> = {}) => ({
  state: "MERGED" as const,
  mergeCommit: { oid: MERGE, targetBranch: "main", url: "https://x/c" },
  reviewDecision: "APPROVED" as const,
  reviewSubmitted: true,
  ...extra,
});

const SEQUENCES: Array<{
  name: string;
  initial: Task;
  pipeline?: DeploymentPipeline;
  steps: Step[];
}> = [
  {
    name: "author happy path: review, changes requested, new head, approval, merge, two stages, refused landing, land",
    initial: baseTask("dev"),
    pipeline: TWO_STAGES,
    steps: [
      {},
      { pr: {} },
      { pr: { reviewRequested: true } },
      {
        pr: {
          reviewRequested: false,
          reviewSubmitted: true,
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedOnHead: true,
        },
      },
      {},
      {
        pr: {
          reviewSubmitted: true,
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedOnHead: false,
          headRefOid: "head2",
          reviewRequested: true,
        },
      },
      {
        pr: {
          reviewSubmitted: true,
          reviewDecision: "APPROVED",
          headRefOid: "head2",
        },
      },
      {
        pr: merged(),
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
      },
      { deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" } },
      {
        deployed: { [PRE_URL]: "3333333", [PROD_URL]: "2222222" },
        contains: ["3333333"],
      },
      {
        deployed: { [PRE_URL]: "3333333", [PROD_URL]: "2222222" },
        contains: ["3333333"],
      },
      {
        deployed: { [PRE_URL]: "3333333", [PROD_URL]: "4444444" },
        contains: ["3333333", "4444444"],
        landingBlocked: true,
      },
      {
        deployed: { [PRE_URL]: "3333333", [PROD_URL]: "4444444" },
        contains: ["3333333", "4444444"],
        landingBlocked: true,
      },
      {
        deployed: { [PRE_URL]: "3333333", [PROD_URL]: "4444444" },
        contains: ["3333333", "4444444"],
      },
    ],
  },
  {
    name: "draft flips, human COMMENTED feedback, closed-without-merge quirk",
    initial: baseTask("dev"),
    steps: [
      { pr: { reviewRequested: true } },
      { pr: { reviewRequested: true, isDraft: true } },
      { pr: { reviewRequested: true, isDraft: false } },
      {
        pr: {
          reviewRequested: false,
          reviewSubmitted: true,
          humanFeedbackOnHead: true,
        },
      },
      {
        pr: {
          reviewRequested: true,
          reviewSubmitted: true,
          humanFeedbackOnHead: true,
        },
      },
      {
        pr: {
          reviewRequested: true,
          reviewSubmitted: true,
          humanFeedbackOnHead: false,
          headRefOid: "head2",
        },
      },
      { pr: { state: "CLOSED", reviewRequested: true } },
      { manual: { state: "dev" } },
    ],
  },
  {
    name: "no pipeline: merged parks in the stage-less production wait forever; a later pipeline is adopted",
    initial: baseTask("awaiting", { kind: "review" }),
    steps: [
      { pr: merged() },
      {},
      {},
      {
        pipeline: TWO_STAGES,
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
      },
      {
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
        contains: ["2222222"],
      },
      {
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
        contains: ["2222222"],
      },
    ],
  },
  {
    name: "a later stage deployed first jumps the scan; hotfix cherry-picks are recognized",
    initial: baseTask("dev"),
    pipeline: TWO_STAGES,
    steps: [
      { pr: merged() },
      {
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "5555555" },
        log: {
          "5555555": [
            { oid: "9999999", subject: "[Hotfix] alice/widget (#42)" },
          ],
        },
      },
    ],
  },
  {
    name: "a manual (hookless) stage is a gate the scan never crosses",
    initial: baseTask("dev"),
    pipeline: {
      stages: [
        TWO_STAGES.stages[0] as never,
        { id: "qa", label: "QA sign-off" },
        TWO_STAGES.stages[1] as never,
      ],
    },
    steps: [
      { pr: merged() },
      {
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
        contains: ["1111111", "2222222"],
      },
      {
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
        contains: ["1111111", "2222222"],
      },
      {
        manual: {
          state: "awaiting",
          awaiting: {
            kind: "deploy",
            stageId: "prod",
            stageLabel: "Production",
          },
        },
        deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" },
        contains: ["1111111", "2222222"],
      },
    ],
  },
  {
    name: "level-triggered re-evaluation: a manual move into a state the PR contradicts is undone next tick",
    initial: baseTask("awaiting", { kind: "slack" }),
    steps: [
      { pr: merged() },
      {},
      { manual: { state: "dev" } },
      {
        pr: {
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedOnHead: true,
          reviewSubmitted: true,
        },
      },
      { manual: { state: "awaiting", awaiting: { kind: "review" } } },
    ],
  },
];

describe("rules engine ↔ retired movers parity (recorded sequences)", () => {
  for (const sequence of SEQUENCES) {
    it(sequence.name, async () => {
      const { legacyMoves, rulesMoves } = await replay(
        sequence.initial,
        sequence.steps,
        sequence.pipeline,
      );
      expect(rulesMoves).toEqual(legacyMoves);
      // Each sequence really moves the task (guards against a vacuous pass).
      expect(legacyMoves.some((move) => move !== null)).toBe(true);
    });
  }

  it("the audit log names the rule, file and line behind each move", async () => {
    const { rules } = await replay(
      baseTask("dev"),
      [{ pr: { reviewRequested: true } }],
      undefined,
    );
    const applied = rules.audit.filter(
      (entry) => entry.kind === "action" && entry.outcome === "applied",
    );
    expect(applied).toEqual([
      expect.objectContaining({
        ruleId: "review-requested-enter-review",
        file: "rules.yaml",
        line: expect.any(Number),
        taskId: "t1",
        action: "move",
      }),
    ]);
  });
});

describe("rules engine ↔ retired movers parity (observePullRequest matrix, first observation)", () => {
  const taskStates: Array<[Task["state"], AwaitingKind?]> = [
    ["dev"],
    ["awaiting", { kind: "review" }],
    ["awaiting", { kind: "slack" }],
    ["awaiting", { kind: "deploy", stageId: "pre", stageLabel: "Preprod" }],
  ];
  const prs: Array<Partial<PullRequestStatus>> = [];
  for (const state of ["OPEN", "MERGED", "CLOSED"] as const) {
    for (const isDraft of [false, true]) {
      for (const reviewDecision of [
        undefined,
        "APPROVED",
        "CHANGES_REQUESTED",
      ] as const) {
        for (const changesRequestedOnHead of [undefined, true, false]) {
          for (const humanFeedbackOnHead of [undefined, true, false]) {
            for (const reviewRequested of [false, true]) {
              for (const reviewSubmitted of [false, true]) {
                prs.push({
                  state,
                  isDraft,
                  ...(reviewDecision ? { reviewDecision } : {}),
                  ...(changesRequestedOnHead === undefined
                    ? {}
                    : { changesRequestedOnHead }),
                  ...(humanFeedbackOnHead === undefined
                    ? {}
                    : { humanFeedbackOnHead }),
                  reviewRequested,
                  reviewSubmitted,
                  ...(state === "MERGED"
                    ? {
                        mergeCommit: {
                          oid: MERGE,
                          targetBranch: "main",
                          url: "https://x/c",
                        },
                      }
                    : {}),
                });
              }
            }
          }
        }
      }
    }
  }

  it(`matches on all ${taskStates.length * prs.length} combinations`, async () => {
    const mismatches: string[] = [];
    let moved = 0;
    for (const [state, awaiting] of taskStates) {
      for (const pr of prs) {
        const { legacyMoves, rulesMoves } = await replay(
          baseTask(state, awaiting),
          [{ pr, deployed: { [PRE_URL]: "1111111", [PROD_URL]: "2222222" } }],
          TWO_STAGES,
        );
        if (legacyMoves[0] !== null) moved += 1;
        if (JSON.stringify(legacyMoves) !== JSON.stringify(rulesMoves)) {
          mismatches.push(
            `${state}/${awaiting?.kind ?? "-"} ${JSON.stringify(pr)}: movers ${JSON.stringify(legacyMoves)} rules ${JSON.stringify(rulesMoves)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(moved).toBeGreaterThan(100);
  }, 120_000);
});
