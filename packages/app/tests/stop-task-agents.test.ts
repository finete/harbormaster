import { describe, expect, it } from "vitest";
import { stopTaskAgents } from "../src/main/stop-task-agents";

const status = (live: boolean, runningTurn = false) => ({ live, runningTurn });

describe("stopTaskAgents", () => {
  it("marks mid-turn tasks interrupted, stops every task it can, and names live ones it could not stop", async () => {
    const marked: string[][] = [];
    const stopped: string[] = [];
    const result = await stopTaskAgents(["a", "b", "c", "d"], {
      // a: mid-turn in our pty; b: idle in our pty; c: live elsewhere; d: not running at all.
      presence: async (id) =>
        ({ a: status(true, true), b: status(true), c: status(true) })[id] ??
        status(false),
      markInterrupted: async (ids) => {
        marked.push(ids);
      },
      stop: (id) => {
        stopped.push(id);
        return id === "a" || id === "b";
      },
    });
    expect(marked).toEqual([["a"]]);
    expect(stopped).toEqual(["a", "b", "c", "d"]);
    expect(result).toEqual({ stopped: ["a", "b"], notStopped: ["c"] });
  });

  it("a failing interrupt marker never keeps a process running", async () => {
    const result = await stopTaskAgents(["a"], {
      presence: async () => status(true, true),
      markInterrupted: async () => {
        throw new Error("core down");
      },
      stop: () => true,
    });
    expect(result.stopped).toEqual(["a"]);
  });
});
