import { describe, expect, it } from "vitest";
import { createTerminalModeTracker } from "../src/main/terminal-mode-tracker";

function replayOf(...chunks: string[]): string {
  const t = createTerminalModeTracker();
  for (const c of chunks) t.feed(c);
  return t.replaySequence();
}

describe("terminal mode tracker", () => {
  it("replays nothing at defaults", () => {
    expect(replayOf("hello\x1b[31mworld")).toBe("");
  });

  it("tracks a pi-like startup", () => {
    const out = replayOf(
      "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[?7l",
    );
    for (const m of [
      "\x1b[?1049h",
      "\x1b[?1002h",
      "\x1b[?1004h",
      "\x1b[?1006h",
      "\x1b[?2004h",
      "\x1b[?25l",
      "\x1b[?7l",
    ]) {
      expect(out).toContain(m);
    }
    expect(out).not.toContain("\x1b[?1000h"); // replaced by 1002
  });

  it("parses multi-param sequences", () => {
    const out = replayOf("\x1b[?1000;1006h");
    expect(out).toContain("\x1b[?1000h");
    expect(out).toContain("\x1b[?1006h");
  });

  it("handles sequences split at every byte boundary", () => {
    const seq = "ab\x1b[?1002;1006hcd\x1b[?25l";
    for (let i = 1; i < seq.length; i++) {
      const out = replayOf(seq.slice(0, i), seq.slice(i));
      expect(out).toContain("\x1b[?1002h");
      expect(out).toContain("\x1b[?1006h");
      expect(out).toContain("\x1b[?25l");
    }
    const t = createTerminalModeTracker();
    for (const ch of seq) t.feed(ch);
    expect(t.replaySequence()).toContain("\x1b[?1006h");
  });

  it("reset returns a mode to default (omitted from replay)", () => {
    expect(replayOf("\x1b[?2004h", "\x1b[?2004l")).toBe("");
    expect(replayOf("\x1b[?25l\x1b[?25h")).toBe("");
    expect(replayOf("\x1b[?1049h\x1b[?1049l")).toBe("");
    expect(replayOf("\x1b[?1006h\x1b[?1006l")).toBe("");
  });

  it("mouse tracking modes are mutually exclusive (last set wins; reset clears)", () => {
    expect(replayOf("\x1b[?1000h\x1b[?1003h")).toBe("\x1b[?1003h");
    expect(replayOf("\x1b[?1003h\x1b[?1000h")).toBe("\x1b[?1000h");
    expect(replayOf("\x1b[?1002h\x1b[?1002l")).toBe("");
  });

  it("never replays synchronized output (2026) or unknown modes", () => {
    expect(replayOf("\x1b[?2026h\x1b[?9999h")).toBe("");
  });

  it("ignores non-private and malformed CSI", () => {
    expect(replayOf("\x1b[1h\x1b[?h\x1b[?1006x")).toBe("");
  });

  it("keeps the carry bounded on garbage", () => {
    const t = createTerminalModeTracker();
    t.feed(`\x1b[?${"1;".repeat(100_000)}`);
    for (let i = 0; i < 1000; i++) t.feed("1;1;1;1;1;1;1;1;");
    // After garbage, a fresh valid sequence still parses.
    t.feed("x\x1b[?1006h");
    expect(t.replaySequence()).toContain("\x1b[?1006h");
  });
});
