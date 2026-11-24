import { describe, expect, it } from "vitest";
import type { TaskState } from "../src/preload/api";
import {
  type FirstPane,
  firstPane,
} from "../src/renderer/src/lib/workspace-first-pane";

const WT = "/wt/task";

describe("firstPane", () => {
  const cases: [
    string,
    TaskState | undefined,
    TaskState | undefined | null,
    string | undefined,
    FirstPane,
  ][] = [
    ["binding not read yet", "done", null, undefined, "wait"],
    ["working task with its worktree", "working", "working", WT, "create"],
    [
      "parked backlog task: plain shell",
      "backlog",
      "backlog",
      undefined,
      "create",
    ],
    ["done task, worktree cleaned up", "done", "done", undefined, "resume"],
    ["done task whose cleanup left its worktree", "done", "done", WT, "create"],
    [
      "resume landed, new worktree not read yet",
      "working",
      "done",
      undefined,
      "resume",
    ],
    [
      "resume landed with the new worktree read",
      "working",
      "working",
      WT,
      "create",
    ],
    [
      "restore: read before the board has the task",
      undefined,
      undefined,
      undefined,
      "wait",
    ],
    [
      "restore: board filled, done task re-read pending",
      "done",
      undefined,
      undefined,
      "wait",
    ],
    [
      "restore: board filled, backlog task re-read pending",
      "backlog",
      undefined,
      undefined,
      "wait",
    ],
    [
      "state moved on while a worktree read was stale",
      "awaiting",
      "working",
      WT,
      "wait",
    ],
  ];

  it.each(cases)("%s", (_name, taskState, readFor, cwd, expected) => {
    expect(firstPane({ taskState, readFor, cwd })).toBe(expected);
  });
});
