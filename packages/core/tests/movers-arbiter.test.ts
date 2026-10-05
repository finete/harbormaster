// Ported from pi-home's tests/unit/transition-machine.test.ts: the generic
// arbiter owns no domain rules, so these tests use fake movers rather than
// the built-ins.

import { describe, expect, it, vi } from "vitest";
import type {
  BoardMove,
  MoverHelpers,
  MoverInput,
  TaskMover,
} from "../src/contracts/addons.js";
import type { TaskState } from "../src/contracts/model.js";
import { arbitrateMove } from "../src/engines/movers/arbiter.js";

const helpers: MoverHelpers = {
  fetchText: async () => {
    throw new Error("unused");
  },
  containsCommit: async () => {
    throw new Error("unused");
  },
  commitLog: async () => {
    throw new Error("unused");
  },
  runHook: async () => {
    throw new Error("unused");
  },
};

const input = (state: TaskState = "dev"): MoverInput => ({
  task: { id: "t1", kind: "task", state },
});

const mover = (
  move: BoardMove,
): TaskMover & { decide: ReturnType<typeof vi.fn> } => ({
  decide: vi.fn(async () => move),
});

describe("arbitrateMove (generic core, no domain rules)", () => {
  it("runs movers in configured order and picks the first non-stay proposal", async () => {
    const stays = mover({ type: "stay" });
    const wins = mover({ type: "review" });
    const never = mover({ type: "done" });
    const decision = await arbitrateMove(input(), helpers, [
      ["a", stays],
      ["b", wins],
      ["c", never],
    ]);
    expect(decision).toEqual({
      move: { type: "review" },
      mover: "b",
      warnings: [],
    });
    expect(stays.decide).toHaveBeenCalledOnce();
    expect(never.decide).not.toHaveBeenCalled();
  });

  it("reordering the same movers changes precedence", async () => {
    const deploy = mover({
      type: "deploy",
      stageId: "pre",
      stageLabel: "Preprod",
    });
    const review = mover({ type: "review" });
    expect(
      (
        await arbitrateMove(input(), helpers, [
          ["d", deploy],
          ["r", review],
        ])
      ).move,
    ).toEqual({ type: "deploy", stageId: "pre", stageLabel: "Preprod" });
    expect(
      (
        await arbitrateMove(input(), helpers, [
          ["r", review],
          ["d", deploy],
        ])
      ).move,
    ).toEqual({ type: "review" });
  });

  it("treats a mover error as stay plus a warning and consults the next mover — errors never move anything", async () => {
    const broken: TaskMover = {
      decide: async () => {
        throw new Error("endpoint down");
      },
    };
    const decision = await arbitrateMove(input(), helpers, [
      ["broken", broken],
      ["ok", mover({ type: "dev" })],
    ]);
    expect(decision.move).toEqual({ type: "dev" });
    expect(decision.warnings).toEqual(["Mover broken: endpoint down"]);
  });

  it("rejects illegal proposals with a warning instead of moving", async () => {
    // backlog can only transition to dev; done and review are illegal from there.
    const illegal = mover({ type: "done" });
    const decision = await arbitrateMove(input("backlog"), helpers, [
      ["illegal", illegal],
    ]);
    expect(decision.move).toEqual({ type: "stay" });
    expect(decision.warnings).toEqual([
      expect.stringContaining("Mover illegal proposed an illegal done move"),
    ]);
    expect(
      (
        await arbitrateMove(input("backlog"), helpers, [
          ["illegal", mover({ type: "review" })],
        ])
      ).move,
    ).toEqual({ type: "stay" });
  });

  it("stays when every mover stays", async () => {
    expect(
      await arbitrateMove(input(), helpers, [["a", mover({ type: "stay" })]]),
    ).toEqual({ move: { type: "stay" }, warnings: [] });
  });
});
