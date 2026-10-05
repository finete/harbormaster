import { describe, expect, it } from "vitest";
import type { Task } from "../src/contracts/model.js";
import { groupColumnTasks } from "../src/engines/board-grouping.js";

let counter = 0;
const makeTask = (overrides: Partial<Task> = {}): Task => {
  counter += 1;
  return {
    id: `task-${counter}`,
    kind: "task",
    state: "dev",
    title: `Task ${counter}`,
    initialPrompt: "do it",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stateChangedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
};

describe("groupColumnTasks", () => {
  it("groups non-awaiting columns by repositoryId, alphabetical by short name", () => {
    const zebra = makeTask({ repositoryId: "github.com/org/zebra" });
    const apple = makeTask({ repositoryId: "github.com/org/apple" });
    const groups = groupColumnTasks("dev", [zebra, apple]);

    expect(groups.map((g) => g.repoLabel)).toEqual(["apple", "zebra"]);
    expect(groups.every((g) => g.primaryLabel === undefined)).toBe(true);
    expect(groups[0]!.tasks).toEqual([apple]);
    expect(groups[1]!.tasks).toEqual([zebra]);
  });

  it("falls back repository-less tasks into a trailing 'scratch' group", () => {
    const scratchTask = makeTask();
    const repoTask = makeTask({ repositoryId: "github.com/org/apple" });
    const groups = groupColumnTasks("dev", [scratchTask, repoTask]);

    expect(groups.map((g) => g.repoLabel)).toEqual(["apple", "scratch"]);
    expect(groups[1]!.tasks).toEqual([scratchTask]);
  });

  it("orders tasks within a group by stateChangedAt ascending", () => {
    const later = makeTask({
      repositoryId: "github.com/org/repo",
      stateChangedAt: "2026-01-02T00:00:00.000Z",
    });
    const earlier = makeTask({
      repositoryId: "github.com/org/repo",
      stateChangedAt: "2026-01-01T00:00:00.000Z",
    });
    const groups = groupColumnTasks("dev", [later, earlier]);

    expect(groups[0]!.tasks).toEqual([earlier, later]);
  });

  it("groups the awaiting column by (awaiting kind/stage, repositoryId)", () => {
    const reviewA = makeTask({
      state: "awaiting",
      awaiting: { kind: "review" },
      repositoryId: "github.com/org/apple",
    });
    const reviewB = makeTask({
      state: "awaiting",
      awaiting: { kind: "review" },
      repositoryId: "github.com/org/banana",
    });
    const slack = makeTask({
      state: "awaiting",
      awaiting: { kind: "slack", permalink: "https://x.slack.com/p1" },
      repositoryId: "github.com/org/apple",
    });
    const deployStaging = makeTask({
      state: "awaiting",
      awaiting: {
        kind: "deploy",
        stageId: "staging",
        stageLabel: "Staging",
      },
      repositoryId: "github.com/org/apple",
    });
    const deployProd = makeTask({
      state: "awaiting",
      awaiting: {
        kind: "deploy",
        stageId: "prod",
        stageLabel: "Production",
      },
      repositoryId: "github.com/org/apple",
    });

    const groups = groupColumnTasks("awaiting", [
      slack,
      reviewB,
      reviewA,
      deployStaging,
      deployProd,
    ]);

    // deploy stages (stageLabel asc) first, then review, then slack.
    expect(groups.map((g) => g.primaryLabel)).toEqual([
      "Production",
      "Staging",
      "Review",
      "Review",
      "Slack response",
    ]);
    expect(groups.map((g) => g.repoLabel)).toEqual([
      "apple",
      "apple",
      "apple",
      "banana",
      "apple",
    ]);
    expect(groups.find((g) => g.primaryLabel === "Production")!.tasks).toEqual([
      deployProd,
    ]);
    expect(
      groups.filter((g) => g.primaryLabel === "Review").map((g) => g.tasks),
    ).toEqual([[reviewA], [reviewB]]);
  });

  it("treats a task awaiting without a stored reason as a review wait", () => {
    const task = makeTask({ state: "awaiting" });
    const groups = groupColumnTasks("awaiting", [task]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.primaryLabel).toBe("Review");
  });

  it("gives awaiting tasks without a repositoryId a trailing scratch group", () => {
    const task = makeTask({ state: "awaiting", awaiting: { kind: "review" } });
    const groups = groupColumnTasks("awaiting", [task]);

    expect(groups[0]!.repoLabel).toBe("scratch");
  });
});
