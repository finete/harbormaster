import { describe, expect, it, vi } from "vitest";
import { clearTerminal } from "../src/renderer/src/lib/terminal-host/clear";

function fakeTerminal(type: "normal" | "alternate") {
  return { buffer: { active: { type } }, clear: vi.fn() };
}

describe("clearTerminal (Cmd+K / context-menu Clear)", () => {
  it("clears the normal buffer", () => {
    const terminal = fakeTerminal("normal");
    expect(clearTerminal(terminal)).toBe(true);
    expect(terminal.clear).toHaveBeenCalledOnce();
  });

  it("leaves a fullscreen program's alternate screen alone", () => {
    const terminal = fakeTerminal("alternate");
    expect(clearTerminal(terminal)).toBe(false);
    expect(terminal.clear).not.toHaveBeenCalled();
  });
});
