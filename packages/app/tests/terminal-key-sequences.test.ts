import { describe, expect, it } from "vitest";
import {
  csiUSequenceForKeyEvent,
  macTextEditingSequence,
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

  it("maps Ctrl+Shift+F to ESC [102;6u", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({ key: "F", shiftKey: true, ctrlKey: true, code: "KeyF" }),
      ),
    ).toBe("\u001b[102;6u");
  });

  it("maps Ctrl+Shift+P to ESC [112;6u", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({ key: "P", shiftKey: true, ctrlKey: true, code: "KeyP" }),
      ),
    ).toBe("\u001b[112;6u");
  });

  it("does not map Ctrl+Shift+letter when Meta is held", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({
          key: "F",
          shiftKey: true,
          ctrlKey: true,
          metaKey: true,
          code: "KeyF",
        }),
      ),
    ).toBeNull();
  });

  it("does not map Ctrl+Shift+letter when Alt is held", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({
          key: "F",
          shiftKey: true,
          ctrlKey: true,
          altKey: true,
          code: "KeyF",
        }),
      ),
    ).toBeNull();
  });

  it("maps Ctrl+Alt+] to ESC [93;7u", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({
          key: "]",
          ctrlKey: true,
          altKey: true,
          code: "BracketRight",
        }),
      ),
    ).toBe("\u001b[93;7u");
  });

  it("does not map Ctrl+Alt+] when Shift is held", () => {
    expect(
      csiUSequenceForKeyEvent(
        keydown({
          key: "}",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          code: "BracketRight",
        }),
      ),
    ).toBeNull();
  });
});

describe("macTextEditingSequence", () => {
  function macKeydown(
    overrides: Partial<TerminalKeyEventInput> & { key: string },
  ): TerminalKeyEventInput {
    return {
      type: "keydown",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: true, // mac combos require meta
      isComposing: false,
      ...overrides,
    };
  }

  it("maps Meta+ArrowLeft to Ctrl-A on mac", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "ArrowLeft" }), { isMac: true }),
    ).toBe("\x01");
  });

  it("maps Meta+ArrowRight to Ctrl-E on mac", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "ArrowRight" }), {
        isMac: true,
      }),
    ).toBe("\x05");
  });

  it("maps Meta+Backspace to Ctrl-U on mac", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "Backspace" }), { isMac: true }),
    ).toBe("\x15");
  });

  it("maps Meta+Delete to Ctrl-K on mac", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "Delete" }), { isMac: true }),
    ).toBe("\x0b");
  });

  it("returns null when Shift is held (selection gestures)", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "ArrowLeft", shiftKey: true }), {
        isMac: true,
      }),
    ).toBeNull();
  });

  it("returns null on non-mac", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "ArrowLeft" }), {
        isMac: false,
      }),
    ).toBeNull();
  });

  it("returns null mid-IME composition", () => {
    expect(
      macTextEditingSequence(
        macKeydown({ key: "ArrowLeft", isComposing: true }),
        { isMac: true },
      ),
    ).toBeNull();
  });

  it("returns null for keyup events", () => {
    expect(
      macTextEditingSequence(
        { ...macKeydown({ key: "ArrowLeft" }), type: "keyup" },
        { isMac: true },
      ),
    ).toBeNull();
  });

  it("returns null for unrelated keys", () => {
    expect(
      macTextEditingSequence(macKeydown({ key: "a" }), { isMac: true }),
    ).toBeNull();
  });
});
