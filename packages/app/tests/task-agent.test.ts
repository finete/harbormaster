import { describe, expect, it } from "vitest";
import {
  shortModelName,
  taskAgentLabel,
} from "../src/renderer/src/lib/task-agent";

describe("taskAgentLabel", () => {
  it("shows harness and the short model name, preferring the task's own choice", () => {
    expect(
      taskAgentLabel({
        harness: "pi",
        model: "anthropic/claude-opus-4-8",
        sessionModel: "anthropic/other",
      }),
    ).toBe("pi · claude-opus-4-8");
  });
  it("falls back to the legacy launch model, then the recorded session model", () => {
    expect(
      taskAgentLabel({
        launch: { status: "queued", requestedAt: "t", model: "openai/gpt-5" },
      }),
    ).toBe("pi · gpt-5");
    expect(taskAgentLabel({ sessionModel: "anthropic/haiku" })).toBe(
      "pi · haiku",
    );
  });
  it("is just the harness when no model is known", () => {
    expect(taskAgentLabel({})).toBe("pi");
    expect(shortModelName("bare")).toBe("bare");
  });
});
