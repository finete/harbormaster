// Pure-logic tests for the in-session command surface (task-commands.ts):
// kind-option formatting, input collection, and confirmation wiring against
// a fake core/ctx — no real `pi` ExtensionAPI or UI needed. End-to-end
// dialog rendering (the real `ctx.ui.select`/`confirm`/`input` TUI) is only
// hand-testable; see extension-wiring.test.ts for the wiring-level coverage
// that exercises these functions through a fake `pi.registerCommand`.

import type {
  AwaitingKindField,
  AwaitingKindOption,
  ToDoneResult,
} from "@harbormaster/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildAwaitInputs,
  buildAwaitingKindChoices,
  DONE_MESSAGES,
  DONE_QUESTIONS,
  runToAwaitCommand,
  runToDevCommand,
  runToDoneCommand,
  type TaskCommandsCore,
  type TaskCommandsUi,
} from "../src/task-commands.js";

function fakeUi(overrides: Partial<TaskCommandsUi> = {}): TaskCommandsUi & {
  notifications: Array<{ message: string; type?: string }>;
} {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    select: overrides.select ?? (async () => undefined),
    confirm: overrides.confirm ?? (async () => false),
    input: overrides.input ?? (async () => undefined),
    notify:
      overrides.notify ??
      ((message, type) => {
        notifications.push({ message, type });
      }),
    notifications,
  };
}

describe("buildAwaitingKindChoices", () => {
  const base: AwaitingKindOption = {
    id: "review",
    label: "Review",
    description: "Waiting on a pull-request review",
    fields: [],
    available: true,
  };

  it("omits unavailable kinds", () => {
    const choices = buildAwaitingKindChoices([
      base,
      {
        ...base,
        id: "deploy",
        label: "Deployment",
        available: false,
        unavailableReason: "no PR",
      },
    ]);
    expect(choices).toEqual([{ id: "review", display: "Review" }]);
  });

  it("folds a kind's notice into the display label", () => {
    const choices = buildAwaitingKindChoices([
      {
        ...base,
        id: "deploy",
        label: "Deployment",
        notice:
          "Squash-merges PR #12 and enters the deployment pipeline (Production)",
      },
    ]);
    expect(choices).toEqual([
      {
        id: "deploy",
        display:
          "Deployment — Squash-merges PR #12 and enters the deployment pipeline (Production)",
      },
    ]);
  });
});

describe("buildAwaitInputs", () => {
  const slackField: AwaitingKindField = {
    id: "permalink",
    label: "Slack permalink",
    optional: true,
  };
  const requiredField: AwaitingKindField = {
    id: "token",
    label: "Required token",
    optional: false,
  };

  it("trims and keeps a filled optional field", () => {
    const result = buildAwaitInputs([slackField], {
      permalink: "  https://x  ",
    });
    expect(result).toEqual({ ok: true, inputs: { permalink: "https://x" } });
  });

  it("drops a blank optional field", () => {
    const result = buildAwaitInputs([slackField], { permalink: "   " });
    expect(result).toEqual({ ok: true, inputs: {} });
  });

  it("aborts with the missing field when a required field is blank", () => {
    const result = buildAwaitInputs([requiredField], {});
    expect(result).toEqual({ ok: false, missingField: requiredField });
  });
});

describe("runToDevCommand", () => {
  it("moves to dev and notifies success", async () => {
    const moveTask = vi.fn().mockResolvedValue({});
    const core: TaskCommandsCore = { commands: { moveTask } as never };
    const ui = fakeUi();

    const ok = await runToDevCommand(core, "task-1", ui);

    expect(ok).toBe(true);
    expect(moveTask).toHaveBeenCalledWith("task-1", "dev");
    expect(ui.notifications).toEqual([
      { message: "Moved to Dev", type: "info" },
    ]);
  });

  it("surfaces a transition error via ctx.ui.notify", async () => {
    const moveTask = vi
      .fn()
      .mockRejectedValue(new Error("Illegal transition: done -> dev"));
    const core: TaskCommandsCore = { commands: { moveTask } as never };
    const ui = fakeUi();

    const ok = await runToDevCommand(core, "task-1", ui);

    expect(ok).toBe(false);
    expect(ui.notifications).toEqual([
      { message: "Illegal transition: done -> dev", type: "error" },
    ]);
  });
});

describe("runToAwaitCommand", () => {
  const reviewOption: AwaitingKindOption = {
    id: "review",
    label: "Review",
    description: "Waiting on a pull-request review",
    fields: [],
    available: true,
  };
  const slackOption: AwaitingKindOption = {
    id: "slack",
    label: "Slack response",
    description: "Waiting on a reply in a Slack thread",
    fields: [{ id: "permalink", label: "Slack permalink", optional: true }],
    available: true,
  };

  it("notifies and stops when no kind applies", async () => {
    const listAwaitingKinds = vi.fn().mockResolvedValue([]);
    const core: TaskCommandsCore = { commands: { listAwaitingKinds } as never };
    const ui = fakeUi();

    const ok = await runToAwaitCommand(core, "task-1", ui);

    expect(ok).toBe(false);
    expect(ui.notifications).toEqual([
      {
        message: "No awaiting kind applies to this task right now",
        type: "warning",
      },
    ]);
  });

  it("leaves the task untouched when the select is cancelled", async () => {
    const listAwaitingKinds = vi.fn().mockResolvedValue([reviewOption]);
    const toAwait = vi.fn();
    const core: TaskCommandsCore = {
      commands: { listAwaitingKinds, toAwait } as never,
    };
    const ui = fakeUi({ select: async () => undefined });

    const ok = await runToAwaitCommand(core, "task-1", ui);

    expect(ok).toBe(false);
    expect(toAwait).not.toHaveBeenCalled();
  });

  it("collects field inputs and calls toAwait with the chosen kind", async () => {
    const listAwaitingKinds = vi
      .fn()
      .mockResolvedValue([reviewOption, slackOption]);
    const toAwait = vi.fn().mockResolvedValue({});
    const core: TaskCommandsCore = {
      commands: { listAwaitingKinds, toAwait } as never,
    };
    const ui = fakeUi({
      select: async (_title, options) =>
        options.find((o) => o.startsWith("Slack")),
      input: async () => "https://workspace.slack.com/archives/x",
    });

    const ok = await runToAwaitCommand(core, "task-1", ui);

    expect(ok).toBe(true);
    expect(toAwait).toHaveBeenCalledWith("task-1", "slack", {
      inputs: { permalink: "https://workspace.slack.com/archives/x" },
    });
    expect(ui.notifications).toEqual([
      { message: "Awaiting Slack response", type: "info" },
    ]);
  });
});

describe("runToDoneCommand", () => {
  it("moves straight to done when core asks nothing", async () => {
    const toDone = vi.fn().mockResolvedValue({ task: {} });
    const core: TaskCommandsCore = { commands: { toDone } as never };
    const ui = fakeUi();

    const ok = await runToDoneCommand(core, "task-1", ui);

    expect(ok).toBe(true);
    expect(ui.notifications).toEqual([
      { message: "Moved to Done", type: "info" },
    ]);
  });

  it("surfaces a landing warning instead of the default success notice", async () => {
    const toDone = vi
      .fn()
      .mockResolvedValue({ task: {}, warning: "worktree still in use" });
    const core: TaskCommandsCore = { commands: { toDone } as never };
    const ui = fakeUi();

    const ok = await runToDoneCommand(core, "task-1", ui);

    expect(ok).toBe(true);
    expect(ui.notifications).toEqual([
      { message: "worktree still in use", type: "warning" },
    ]);
  });

  it("confirms with the app's exact dirty-worktree wording, then retries with removeDirty", async () => {
    const confirmation: ToDoneResult = {
      requiresConfirmation: "dirty",
      detail: "/code/task-1",
    };
    const toDone = vi
      .fn()
      .mockResolvedValueOnce(confirmation)
      .mockResolvedValueOnce({ task: {} });
    const core: TaskCommandsCore = { commands: { toDone } as never };
    const confirm = vi.fn().mockResolvedValue(true);
    const ui = fakeUi({ confirm });

    const ok = await runToDoneCommand(core, "task-1", ui);

    expect(ok).toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      DONE_QUESTIONS.dirty.title,
      `${DONE_MESSAGES.dirty} (/code/task-1)`,
    );
    expect(toDone).toHaveBeenNthCalledWith(2, "task-1", {
      force: { removeDirty: true },
    });
  });

  it("leaves the task untouched when the confirm is declined", async () => {
    const confirmation: ToDoneResult = {
      requiresConfirmation: "unmerged",
      detail: "/code/task-1",
    };
    const toDone = vi.fn().mockResolvedValue(confirmation);
    const core: TaskCommandsCore = { commands: { toDone } as never };
    const ui = fakeUi({ confirm: async () => false });

    const ok = await runToDoneCommand(core, "task-1", ui);

    expect(ok).toBe(false);
    expect(toDone).toHaveBeenCalledTimes(1);
  });

  it("stops instead of re-asking the same question twice", async () => {
    const confirmation: ToDoneResult = {
      requiresConfirmation: "unmerged",
      detail: "core refused again",
    };
    const toDone = vi
      .fn()
      .mockResolvedValueOnce(confirmation)
      .mockResolvedValueOnce(confirmation);
    const core: TaskCommandsCore = { commands: { toDone } as never };
    const ui = fakeUi({ confirm: async () => true });

    const ok = await runToDoneCommand(core, "task-1", ui);

    expect(ok).toBe(false);
    expect(toDone).toHaveBeenCalledTimes(2);
    expect(ui.notifications).toEqual([
      { message: "core refused again", type: "error" },
    ]);
  });
});
