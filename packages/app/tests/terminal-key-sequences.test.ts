import { describe, expect, it } from "vitest";
import {
  csiUSequenceForKeyEvent,
  type TerminalKeyEventInput,
} from "../src/renderer/src/lib/terminal-key-sequences";

function keydown(
  overrides: Partial<TerminalKeyEventInput> & { key: string },
): TerminalKeyEventInput {
  return {
    type: "keydown",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("csiUSequenceForKeyEvent", () => {
  it("maps Shift+Enter to ESC [13;2u", () => {
    expect(
      csiUSequenceForKeyEvent(keydown({ key: "Enter", shiftKey: true })),
    ).toBe("\u001b[13;2u");
  });

  it("maps Alt+Enter to ESC [13;3u", () => {
    expect(
      csiUSequenceForKeyEvent(keydown({ key: "Enter", altKey: true })),
    ).toBe("\u001b[13;3u");
  });

  it("maps Ctrl+Enter to ESC [13;5u", () => {
    expect(
      csiUSequenceForKeyEvent(keydown({ key: "Enter", ctrlKey: true })),
    ).toBe("\u001b[13;5u");
  });

  it("maps Ctrl+Minus to ESC [45;5u (Zed parity)", () => {
    expect(csiUSequenceForKeyEvent(keydown({ key: "-", ctrlKey: true }))).toBe(
      "\u001b[45;5u",
    );
  });

  it("does not map plain Enter", () => {
    expect(csiUSequenceForKeyEvent(keydown({ key: "Enter" }))).toBeNull();
  });

  it("does not map Shift+a (ordinary shifted key)", () => {
    expect(
      csiUSequenceForKeyEvent(keydown({ key: "a", shiftKey: true })),
    ).toBeNull();
  });

  it("does not map plain Minus (no modifier)", () => {
    expect(csiUSequenceForKeyEvent(keydown({ key: "-" }))).toBeNull();
  });

  it("ignores keydowns mid IME composition, even for a mapped combo", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({ key: "Enter", shiftKey: true, isComposing: true }),
      ),
    ).toBeNull();
  });

  it("ignores non-keydown events (e.g. keyup) for a mapped combo", () => {
    expect(
      csiUSequenceForKeyEvent({
        type: "keyup",
        key: "Enter",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
      }),
    ).toBeNull();
  });

  it("does not map a mapped combo when Meta is also held", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({ key: "Enter", shiftKey: true, metaKey: true }),
      ),
    ).toBeNull();
  });

  it("does not map Ctrl+Shift+Enter (ambiguous combo, outside pi's set)", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({ key: "Enter", ctrlKey: true, shiftKey: true }),
      ),
    ).toBeNull();
  });
});
