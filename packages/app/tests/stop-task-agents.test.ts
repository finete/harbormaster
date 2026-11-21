import { describe, expect, it } from "vitest";
import { stopTaskAgents } from "../src/main/stop-task-agents";

describe("stopTaskAgents", () => {
  it("marks mid-turn tasks interrupted, stops every task, and reports who had a live process", async () => {
    const marked: string[][] = [];
    const stopped: string[] = [];
    const result = await stopTaskAgents(["a", "b", "c"], {
      isMidTurn: async (id) => id === "a",
      markInterrupted: async (ids) => {
        marked.push(ids);
      },
      stop: (id) => {
        stopped.push(id);
        return id !== "c";
      },
    });
    expect(marked).toEqual([["a"]]);
    expect(stopped).toEqual(["a", "b", "c"]);
    expect(result).toEqual(["a", "b"]);
  });

  it("a failing interrupt marker never keeps a process running", async () => {
    const result = await stopTaskAgents(["a"], {
      isMidTurn: async () => true,
      markInterrupted: async () => {
        throw new Error("core down");
      },
      stop: () => true,
    });
    expect(result).toEqual(["a"]);
  });
});
