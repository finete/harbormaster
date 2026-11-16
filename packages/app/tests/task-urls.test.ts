// Agent-opened URL routing (lib/task-urls.ts, docs/plannotator.md
// decisions 2/6): a Plannotator URL queues a non-focusing review open;
// other URLs queue a preview; the Review button queues a focusing open; the
// workspace takes its queue.
import { describe, expect, it } from "vitest";
import {
  applyReviewRequested,
  applyUrlOpened,
  EMPTY_TASK_URL_STATE,
  reviewPanelId,
  takePending,
} from "../src/renderer/src/lib/task-urls";

describe("task URL routing", () => {
  it("routes a Plannotator URL to the review tab without focus", () => {
    const state = applyUrlOpened(EMPTY_TASK_URL_STATE, {
      taskId: "t1",
      url: "http://127.0.0.1:1/",
      source: "plannotator",
    });
    expect(state.pending.t1).toEqual([
      { kind: "review", url: "http://127.0.0.1:1/", focus: false },
    ]);
  });

  it("routes any other URL to a preview", () => {
    const state = applyUrlOpened(EMPTY_TASK_URL_STATE, {
      taskId: "t1",
      url: "http://localhost:3000/",
      source: "browser",
    });
    expect(state.pending.t1).toEqual([
      { kind: "preview", url: "http://localhost:3000/" },
    ]);
  });

  it("the Review button queues a focusing open with no URL yet", () => {
    const state = applyReviewRequested(EMPTY_TASK_URL_STATE, "t2");
    expect(state.pending.t2).toEqual([{ kind: "review", focus: true }]);
  });

  it("taking the queue is per task", () => {
    let state = applyReviewRequested(EMPTY_TASK_URL_STATE, "t1");
    state = applyUrlOpened(state, {
      taskId: "t2",
      url: "http://127.0.0.1:1/",
      source: "plannotator",
    });
    state = takePending(state, "t1");
    expect(Object.keys(state.pending)).toEqual(["t2"]);
    expect(takePending(state, "t1")).toBe(state);
  });

  it("names the one review tab per task", () => {
    expect(reviewPanelId("abc")).toBe("review:abc");
  });
});
