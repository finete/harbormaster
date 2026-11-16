// Agent-opened URL routing (lib/task-urls.ts, docs/plannotator.md
// decisions 2/6): a Plannotator URL queues a non-focusing review open and
// marks the task; other URLs queue a preview; the Review button queues a
// focusing open; the workspace takes its queue; seeing the tab clears the mark.
import { describe, expect, it } from "vitest";
import {
  applyReviewRequested,
  applyUrlOpened,
  clearMark,
  EMPTY_TASK_URL_STATE,
  reviewPanelId,
  takePending,
} from "../src/renderer/src/lib/task-urls";

describe("task URL routing", () => {
  it("routes a Plannotator URL to the review tab without focus and marks the task", () => {
    const state = applyUrlOpened(EMPTY_TASK_URL_STATE, {
      taskId: "t1",
      url: "http://127.0.0.1:1/",
      source: "plannotator",
    });
    expect(state.pending.t1).toEqual([
      { kind: "review", url: "http://127.0.0.1:1/", focus: false },
    ]);
    expect(state.marked).toEqual(["t1"]);
    expect(
      applyUrlOpened(state, {
        taskId: "t1",
        url: "http://127.0.0.1:2/",
        source: "plannotator",
      }).marked,
    ).toEqual(["t1"]);
  });

  it("routes any other URL to a preview, unmarked", () => {
    const state = applyUrlOpened(EMPTY_TASK_URL_STATE, {
      taskId: "t1",
      url: "http://localhost:3000/",
      source: "browser",
    });
    expect(state.pending.t1).toEqual([
      { kind: "preview", url: "http://localhost:3000/" },
    ]);
    expect(state.marked).toEqual([]);
  });

  it("the Review button queues a focusing open with no URL yet", () => {
    const state = applyReviewRequested(EMPTY_TASK_URL_STATE, "t2");
    expect(state.pending.t2).toEqual([{ kind: "review", focus: true }]);
  });

  it("taking the queue and clearing the mark are per task", () => {
    let state = applyReviewRequested(EMPTY_TASK_URL_STATE, "t1");
    state = applyUrlOpened(state, {
      taskId: "t2",
      url: "http://127.0.0.1:1/",
      source: "plannotator",
    });
    state = takePending(state, "t1");
    expect(Object.keys(state.pending)).toEqual(["t2"]);
    expect(takePending(state, "t1")).toBe(state);
    state = clearMark(state, "t2");
    expect(state.marked).toEqual([]);
    expect(clearMark(state, "t2")).toBe(state);
  });

  it("names the one review tab per task", () => {
    expect(reviewPanelId("abc")).toBe("review:abc");
  });
});
